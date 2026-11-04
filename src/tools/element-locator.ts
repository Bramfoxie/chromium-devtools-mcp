import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { documentSchema, resolvedSchema } from "./cdp-schemas.js";
import { parseCdp } from "./cdp-parse.js";
import { ToolError } from "./errors.js";
import {
    describeLocator,
    type ElementLocator,
    nameMatches,
    pickMatch,
} from "./locator-schema.js";
import { type ResolverFrames, scopeNode } from "./element-selector.js";

const axNodesSchema = z.object({
    nodes: z.array(
        z.object({
            ignored         : z.boolean().optional(),
            role            : z.object({ value: z.unknown().optional() }).passthrough().optional(),
            name            : z.object({ value: z.unknown().optional() }).passthrough().optional(),
            backendDOMNodeId: z.number().optional(),
        }).passthrough(),
    ),
});

const textMatchesSchema = z.object({
    result: z.object({
        value: z.object({ count: z.number() }).optional(),
    }),
});

const TEXT_FIND = `function (text, exact, nth, wantElement) {
  const want = text.replace(/\\s+/g, " ").trim().toLowerCase();
  const doc = this.nodeType === 9 ? this : this.ownerDocument;
  const hits = [];
  const seen = new Set();
  const skipped = ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"];
  const visit = (root) => {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ALL);
    let node = walker.currentNode;
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const have = (node.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase();
        const holder = node.parentElement;
        const matched = exact ? have === want : have.length > 0 && have.includes(want);
        if (matched && holder && !seen.has(holder) && !skipped.includes(holder.tagName)) {
          const box = holder.getBoundingClientRect();
          const style = doc.defaultView.getComputedStyle(holder);
          if (style.visibility !== "hidden" && style.display !== "none" && (box.width > 0 || box.height > 0)) {
            seen.add(holder);
            hits.push(holder);
          }
        }
      } else if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot) {
        visit(node.shadowRoot);
      }
      node = walker.nextNode();
    }
  };
  visit(doc.body || doc.documentElement);
  return wantElement ? (hits[nth] || null) : { count: hits.length };
}`;

async function byRole(
    access : DaemonAccess,
    tab    : string,
    frameId: string | undefined,
    locator: ElementLocator,
): Promise<number[]> {
    const result = parseCdp(
        "Accessibility.getFullAXTree",
        axNodesSchema,
        await access.send({
            targetId: tab,
            method  : "Accessibility.getFullAXTree",
            params  : frameId === undefined ? {} : { frameId },
        }),
    );
    const exact = locator.exact === true;
    const wanted = locator.role?.toLowerCase();

    return result.nodes
        .filter((node) => node.ignored !== true)
        .filter((node) => String(node.role?.value ?? "").toLowerCase() === wanted)
        .filter((node) =>
            locator.name === undefined
            || nameMatches(String(node.name?.value ?? ""), locator.name, exact))
        .flatMap((node) => (node.backendDOMNodeId === undefined ? [] : [node.backendDOMNodeId]));
}

async function scopeObject(access: DaemonAccess, tab: string, nodeId: number): Promise<string> {
    const resolved = parseCdp(
        "DOM.resolveNode",
        resolvedSchema,
        await access.send({ targetId: tab, method: "DOM.resolveNode", params: { nodeId } }),
    );

    if (resolved.object.objectId === undefined) {
        throw new ToolError("The document to search is gone. Run the call again.");
    }

    return resolved.object.objectId;
}

async function byText(
    access : DaemonAccess,
    tab    : string,
    scopeId: number,
    locator: ElementLocator,
): Promise<{
    count: number;
    pick : (nth: number) => Promise<{ objectId: string; backendNodeId: number }>;
}> {
    const objectId = await scopeObject(access, tab, scopeId);
    const call = (nth: number, wantElement: boolean) =>
        access.send({
            targetId: tab,
            method  : "Runtime.callFunctionOn",
            params  : {
                objectId,
                functionDeclaration: TEXT_FIND,
                arguments          : [
                    { value: locator.text },
                    { value: locator.exact === true },
                    { value: nth },
                    { value: wantElement },
                ],
                returnByValue: !wantElement,
            },
        });
    const counted = textMatchesSchema.safeParse(await call(0, false));
    const count = counted.success ? (counted.data.result.value?.count ?? 0) : 0;

    return {
        count,
        pick: async (nth) => {
            const reply = parseCdp(
                "Runtime.callFunctionOn",
                z.object({ result: z.object({ objectId: z.string().optional() }) }),
                await call(nth, true),
            );
            const element = reply.result.objectId;

            if (element === undefined) {
                throw new ToolError("The element with that text is gone. Run the call again.");
            }

            const described = parseCdp(
                "DOM.describeNode",
                z.object({ node: z.object({ backendNodeId: z.number() }).passthrough() }),
                await access.send({
                    targetId: tab,
                    method  : "DOM.describeNode",
                    params  : { objectId: element },
                }),
            );

            return { objectId: element, backendNodeId: described.node.backendNodeId };
        },
    };
}

export async function resolveByLocator(
    access : DaemonAccess,
    tab    : string,
    locator: ElementLocator,
    options: { frame?: string },
    frames : ResolverFrames | undefined,
): Promise<{ objectId: string; backendNodeId: number; frameId?: string; isolated?: boolean }> {
    const document = parseCdp(
        "DOM.getDocument",
        documentSchema,
        await access.send({
            targetId: tab,
            method  : "DOM.getDocument",
            params  : { depth: 0, pierce: false },
        }),
    );
    const scope = await scopeNode(access, tab, document.root.nodeId, options.frame, frames);
    const scoped = scope.access ?? access;
    const extra = {
        ...(scope.frameId === undefined ? {} : { frameId: scope.frameId }),
        ...(scope.access === undefined ? {} : { isolated: true as const }),
    };

    if (locator.text !== undefined) {
        const found = await byText(scoped, tab, scope.nodeId, locator);
        const index = pickMatch(
            Array.from({ length: found.count }, (_, position) => position),
            locator,
        );

        return { ...(await found.pick(index)), ...extra };
    }

    const backendIds = await byRole(
        scoped,
        tab,
        scope.access === undefined ? scope.frameId : undefined,
        locator,
    );
    const backendNodeId = pickMatch(backendIds, locator);
    const resolved = parseCdp(
        "DOM.resolveNode",
        resolvedSchema,
        await scoped.send({
            targetId: tab,
            method  : "DOM.resolveNode",
            params  : { backendNodeId },
        }),
    );

    if (resolved.object.objectId === undefined) {
        throw new ToolError(
            `The element with ${describeLocator(locator)} is gone from the page. Run the call again.`,
        );
    }

    return { objectId: resolved.object.objectId, backendNodeId, ...extra };
}
