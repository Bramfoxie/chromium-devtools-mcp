import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import type { ToolContext } from "./define-tool.js";
import { ToolError } from "./errors.js";
import type { Rect } from "./element-target.js";
import { type FrameLink, type Point, settleRendering } from "./frame-geometry.js";
import { throwIfCancelled } from "./registry.js";

export const MOVE_BUDGET_MS = 10000;

const MOVE_WAIT_MS = 100;

const RETRY_PAUSE_MIN_MS = 50;

const RETRY_PAUSE_MAX_MS = 500;

const STABLE_ROUNDS = 4;

const LANDING_WAIT_MS = 300;

const PRESS_WAIT_MS = 300;

export const FRAME_ATTEMPTS = 3;

type PointerVia = "frame" | "tab";

export interface PointerTarget {
    via  : PointerVia;
    point: Point;
}

export interface Measurement {
    point: Point;
    local: Point;
    boxes: Rect[];
}

export interface PointerRoute {
    owner     : DaemonAccess;
    frameId   : string;
    objectId  : string;
    relays    : DaemonAccess[];
    links     : FrameLink[];
    initial   : Measurement;
    measure   : () => Promise<Measurement>;
    release   : () => Promise<void>;
    stillOver?: () => Promise<boolean>;
}

const INSTALL = `function cdmProbeInstall() {
  const doc = this.ownerDocument;
  const key = Symbol.for("cdm.pointerProbe");
  const previous = doc[key];
  if (previous) {
    doc.removeEventListener("mousemove", previous.onMove, true);
    doc.removeEventListener("mousedown", previous.onDown, true);
  }
  const probe = { moves: 0, downs: 0, waiters: new Set() };
  const notify = () => { for (const waiter of [...probe.waiters]) waiter(); };
  probe.onMove = () => { probe.moves += 1; notify(); };
  probe.onDown = () => { probe.downs += 1; notify(); };
  doc.addEventListener("mousemove", probe.onMove, true);
  doc.addEventListener("mousedown", probe.onDown, true);
  doc[key] = probe;
  return true;
}`;

const WAIT = `function cdmProbeWait(kind, base, ms) {
  const probe = this.ownerDocument[Symbol.for("cdm.pointerProbe")];
  if (!probe) return -1;
  return new Promise((resolve) => {
    if (probe[kind] > base) return resolve(probe[kind]);
    const done = () => { clearTimeout(timer); probe.waiters.delete(check); resolve(probe[kind]); };
    const check = () => { if (probe[kind] > base) done(); };
    const timer = setTimeout(done, ms);
    probe.waiters.add(check);
  });
}`;

const READ = `function cdmProbeRead() {
  const probe = this.ownerDocument[Symbol.for("cdm.pointerProbe")];
  return probe ? { moves: probe.moves, downs: probe.downs } : null;
}`;

const REMOVE = `function cdmProbeRemove() {
  const doc = this.ownerDocument;
  const key = Symbol.for("cdm.pointerProbe");
  const probe = doc[key];
  if (!probe) return false;
  doc.removeEventListener("mousemove", probe.onMove, true);
  doc.removeEventListener("mousedown", probe.onDown, true);
  delete doc[key];
  return true;
}`;

const countSchema = z.object({ result: z.object({ value: z.number() }) });
const locationSchema = z.object({ frameId: z.string().optional() });
const readSchema = z.object({
    result: z.object({ value: z.object({ moves: z.number(), downs: z.number() }).nullable() }),
});

type PointerEnv = Pick<ToolContext, "clock" | "signal">;

export class PointerDelivery {
    private current: Measurement;

    private via: PointerVia = "frame";

    constructor(
        private readonly route: PointerRoute,
        private readonly tab  : string,
        private readonly env  : PointerEnv,
    ) {
        this.current = route.initial;
    }

    async install(): Promise<void> {
        await this.call(INSTALL, []);
    }

    async remove(): Promise<void> {
        await this.call(REMOVE, []).catch(() => undefined);
    }

    async prepareMove(sendMove: (target: PointerTarget) => Promise<void>): Promise<PointerTarget> {
        const base = (await this.read()).moves;
        const begun = this.env.clock.now();
        let tabStarted = begun;
        let pauseMs = RETRY_PAUSE_MIN_MS;
        let attempts = 0;
        const hits: boolean[] = [];

        for (;;) {
            throwIfCancelled(this.env.signal);
            attempts += 1;
            const via: PointerVia = attempts <= FRAME_ATTEMPTS ? "frame" : "tab";

            if (attempts === FRAME_ATTEMPTS + 1) tabStarted = this.env.clock.now();

            this.via = via;
            const target = this.targetFor(via);

            await sendMove(target);

            if (await this.wait("moves", base, MOVE_WAIT_MS) > base) return target;

            if (via === "tab") {
                hits.push(await this.frameAt(target.point));

                if (this.env.clock.now() - tabStarted >= MOVE_BUDGET_MS) break;
            }

            await settleRendering(this.route.relays, this.tab);
            await this.pause(pauseMs);
            pauseMs = Math.min(Math.round(pauseMs * 1.5), RETRY_PAUSE_MAX_MS);
            await this.remeasure();
        }

        throw new ToolError(
            `The frame did not receive pointer input from the browser. Make sure the page is visible and not busy, then try again.\n${
                await this.diagnostics(attempts, this.env.clock.now() - begun, sendMove, hits)}`,
        );
    }

    async press(
        press  : (target: PointerTarget) => Promise<void>,
        release: (target: PointerTarget) => Promise<void>,
    ): Promise<void> {
        const first = (await this.read()).downs;

        for (let attempt = 1; attempt <= 2; attempt += 1) {
            throwIfCancelled(this.env.signal);

            if (attempt > 1) await this.remeasure();

            const base = (await this.read()).downs;

            this.via = attempt === 1 ? this.via : "tab";
            const target = this.targetFor(this.via);

            await press(target);
            const seen = await this.wait("downs", base, PRESS_WAIT_MS);

            await release(target);

            if (seen <= base) {
                await settleRendering(this.route.relays, this.tab);

                if ((await this.read()).downs <= base) {
                    if (attempt === 2 || !await this.pointerStillOver()) break;

                    continue;
                }
            }

            if ((await this.read()).downs - first > 1) {
                throw new ToolError(
                    "The frame received the mouse press more than once. Check the page state before repeating the click.",
                );
            }

            return;
        }

        throw new ToolError(
            "The frame did not receive the mouse press from the browser. Make sure the page is visible and not busy, then try again.",
        );
    }

    private async pause(ms: number): Promise<void> {
        await this.env.clock.sleep(ms);
        throwIfCancelled(this.env.signal);
    }

    private targetFor(via: PointerVia): PointerTarget {
        return { via, point: via === "frame" ? this.current.local : this.current.point };
    }

    private async frameAt(point: Point): Promise<boolean> {
        try {
            const parsed = locationSchema.safeParse(
                await this.route.relays[0]?.send({
                    targetId: this.tab,
                    method  : "DOM.getNodeForLocation",
                    params  : { x: Math.round(point.x), y: Math.round(point.y) },
                }),
            );

            return parsed.success && parsed.data.frameId === this.route.frameId;
        } catch {
            return false;
        }
    }

    private async remeasure(): Promise<void> {
        try {
            let latest = await this.route.measure();

            for (let round = 1; round < STABLE_ROUNDS; round += 1) {
                await settleRendering(this.route.relays, this.tab);

                const next = await this.route.measure();
                const same = JSON.stringify(next) === JSON.stringify(latest);

                latest = next;

                if (same) break;
            }

            this.current = latest;
        } catch {
            return;
        }
    }

    private async diagnostics(
        attempts: number,
        elapsed : number,
        sendMove: (target: PointerTarget) => Promise<void>,
        hits    : boolean[],
    ): Promise<string> {
        const { point, boxes } = this.current;
        const landed = await this.landing(point, sendMove);
        const dpr = await this.pixelRatio();
        const visibility = await this.visibility();
        const frames = boxes.map((box) => `(${box.x},${box.y},${box.width},${box.height})`).join(" ");

        return `Diagnostics: attempts=${attempts} elapsedMs=${elapsed} point=(${point.x},${point.y}) depth=${boxes.length} frames=${frames} dpr=${dpr} landed=${landed} visibility=${visibility} route=${this.via} hit=${hits.at(-1) ?? false} hits=${hits.filter(Boolean).length}/${hits.length}`;
    }

    private async landing(
        point   : Point,
        sendMove: (target: PointerTarget) => Promise<void>,
    ): Promise<string> {
        const probes: Array<{ access: DaemonAccess; objectId: string }> = [];

        try {
            for (const link of this.route.links) {
                const resolved = await link.access.send({
                    targetId: this.tab,
                    method  : "DOM.resolveNode",
                    params  : {
                        backendNodeId: link.backendNodeId,
                    },
                }) as { object?: { objectId?: string } } | null;
                const objectId = resolved?.object?.objectId;

                if (objectId === undefined) continue;

                await link.access.send({
                    targetId: this.tab,
                    method  : "Runtime.callFunctionOn",
                    params  : {
                        functionDeclaration: INSTALL,
                        objectId,
                        arguments          : [],
                        returnByValue      : true,
                    },
                });
                probes.push({ access: link.access, objectId });
            }

            await sendMove({ via: "tab", point });
            await this.pause(LANDING_WAIT_MS);

            const seen: string[] = [];

            for (const [index, probe] of probes.entries()) {
                const parsed = readSchema.safeParse(
                    await probe.access.send({
                        targetId: this.tab,
                        method  : "Runtime.callFunctionOn",
                        params  : {
                            functionDeclaration: READ,
                            objectId           : probe.objectId,
                            arguments          : [],
                            returnByValue      : true,
                        },
                    }),
                );
                const moves = parsed.success ? parsed.data.result.value?.moves ?? -1 : -1;

                seen.push(`${probes.length - 1 - index === 0 ? "top" : `up${probes.length - 1 - index}`}:${moves}`);
            }

            return seen.join(",");
        } catch {
            return "unknown";
        } finally {
            for (const probe of probes) {
                await probe.access.send({
                    targetId: this.tab,
                    method  : "Runtime.callFunctionOn",
                    params  : {
                        functionDeclaration: REMOVE,
                        objectId           : probe.objectId,
                        arguments          : [],
                        returnByValue      : true,
                    },
                }).catch(() => undefined);
            }
        }
    }

    private async pixelRatio(): Promise<string> {
        const top = this.route.relays[0];

        try {
            const parsed = z.object({ result: z.object({ value: z.number() }) }).safeParse(
                await top?.send({
                    targetId: this.tab,
                    method  : "Runtime.evaluate",
                    params  : { expression: "window.devicePixelRatio", returnByValue: true },
                }),
            );

            return parsed.success ? String(parsed.data.result.value) : "unknown";
        } catch {
            return "unknown";
        }
    }

    private async visibility(): Promise<string> {
        try {
            const parsed = z.object({ result: z.object({ value: z.enum(["hidden", "visible", "prerender"]) }) }).safeParse(
                await this.route.relays[0]?.send({
                    targetId: this.tab,
                    method  : "Runtime.evaluate",
                    params  : { expression: "document.visibilityState", returnByValue: true },
                }),
            );

            return parsed.success ? parsed.data.result.value : "unknown";
        } catch {
            return "unknown";
        }
    }

    private async pointerStillOver(): Promise<boolean> {
        return this.route.stillOver === undefined ? true : await this.route.stillOver();
    }

    private async read(): Promise<{ moves: number; downs: number }> {
        const parsed = readSchema.safeParse(await this.call(READ, []));
        const value = parsed.success ? parsed.data.result.value : null;

        if (value === null) {
            throw new ToolError(
                "The frame stopped reporting pointer input. Take a new dom_snapshot and try again.",
            );
        }

        return value;
    }

    private async wait(kind: "moves" | "downs", base: number, ms: number): Promise<number> {
        const parsed = countSchema.safeParse(
            await this.call(WAIT, [{ value: kind }, { value: base }, { value: ms }], true),
        );

        if (!parsed.success || parsed.data.result.value < 0) {
            throw new ToolError(
                "The frame stopped reporting pointer input. Take a new dom_snapshot and try again.",
            );
        }

        return parsed.data.result.value;
    }

    private call(declaration: string, args: unknown[], awaitPromise = false): Promise<unknown> {
        return this.route.owner.send({
            targetId: this.tab,
            method  : "Runtime.callFunctionOn",
            params  : {
                functionDeclaration: declaration,
                objectId           : this.route.objectId,
                arguments          : args,
                awaitPromise,
                returnByValue      : true,
            },
        });
    }
}

export async function withPointerDelivery<T>(
    route: PointerRoute | undefined,
    tab  : string,
    env  : PointerEnv,
    run  : (delivery: PointerDelivery | undefined) => Promise<T>,
): Promise<T> {
    if (route === undefined) return run(undefined);

    const delivery = new PointerDelivery(route, tab, env);

    try {
        await delivery.install();

        return await run(delivery);
    } finally {
        await delivery.remove();
        await route.release();
    }
}
