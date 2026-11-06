import { z } from "zod";
import type { CdpClient, CdpSession } from "../cdp/index.js";
import type {
    BackendSession,
    BrowserBackend,
    ChildSessionHandle,
    ChildSessionOptions,
    TargetInfo,
} from "./browser-backend.js";
import { cdpChildTargetsDeps, ChildTargets } from "./child-targets.js";
import { DaemonError } from "./errors.js";
import type { PermissionGrant } from "./permissions.js";

const contextsSchema = z.object({
    browserContextIds      : z.array(z.string()).optional(),
    defaultBrowserContextId: z.string().min(1).optional(),
});
const createdContextSchema = z.object({ browserContextId: z.string().min(1) });
const createdTargetSchema = z.object({ targetId: z.string().min(1) });
const targetInfoSchema = z.object({
    targetId        : z.string().min(1),
    type            : z.string(),
    title           : z.string().default(""),
    url             : z.string().default(""),
    browserContextId: z.string().nullish(),
    openerId        : z.string().min(1).optional(),
});
const targetsSchema = z.object({ targetInfos: z.array(z.unknown()) });
const destroyedSchema = z.object({ targetId: z.string().min(1) });

function parseResult<T>(schema: z.ZodType<T>, value: unknown, method: string): T {
    const result = schema.safeParse(value);

    if (result.success) return result.data;

    throw new DaemonError(`The browser sent an unexpected response to ${method}.`);
}

const peers = new WeakMap<BackendSession, CdpSession>();

function wrapSession(session: CdpSession): BackendSession {
    const wrapped: BackendSession = {
        send  : (method, params, timeoutMs) => session.send(method, params, { timeoutMs }),
        on    : (event, handler) => session.on(event, (params) => handler(params)),
        detach: () => session.detach(),
    };

    peers.set(wrapped, session);

    return wrapped;
}

export class CdpBackend implements BrowserBackend {
    private constructor(
        private readonly client          : CdpClient,
        private readonly defaultContextId: string,
    ) {}

    static async create(client: CdpClient): Promise<CdpBackend> {
        await client.send("Target.setDiscoverTargets", { discover: true });
        const contexts = parseResult(
            contextsSchema,
            await client.send("Target.getBrowserContexts"),
            "Target.getBrowserContexts",
        );

        if (!contexts.defaultBrowserContextId) {
            throw new DaemonError(
                "This browser does not report its default browser context. Update the browser and try again.",
            );
        }

        return new CdpBackend(client, contexts.defaultBrowserContextId);
    }

    async createContext(): Promise<string> {
        const result = await this.client.send("Target.createBrowserContext", {});

        return parseResult(createdContextSchema, result, "Target.createBrowserContext")
            .browserContextId;
    }

    async disposeContext(contextId: string): Promise<void> {
        await this.client.send("Target.disposeBrowserContext", { browserContextId: contextId });
    }

    async setPermission(grant: PermissionGrant): Promise<void> {
        await this.client.send("Browser.setPermission", {
            permission: { name: grant.name },
            setting   : "granted",
            origin    : grant.origin,
            ...(grant.contextId === undefined ? {} : { browserContextId: grant.contextId }),
        });
    }

    async resetPermissions(contextId: string | undefined): Promise<void> {
        await this.client.send("Browser.resetPermissions", {
            ...(contextId === undefined ? {} : { browserContextId: contextId }),
        });
    }

    async createTarget(url: string, contextId: string | undefined): Promise<string> {
        const result = await this.client.send("Target.createTarget", {
            url,
            background: true,
            ...(contextId === undefined ? {} : { browserContextId: contextId }),
        });

        return parseResult(createdTargetSchema, result, "Target.createTarget").targetId;
    }

    async closeTarget(targetId: string): Promise<void> {
        await this.client.send("Target.closeTarget", { targetId });
    }

    async listTargets(): Promise<TargetInfo[]> {
        const result = parseResult(
            targetsSchema,
            await this.client.send("Target.getTargets"),
            "Target.getTargets",
        );

        return result.targetInfos
            .flatMap((entry) => {
                const info = targetInfoSchema.safeParse(entry);

                return info.success ? [info.data] : [];
            })
            .filter((info) => info.type === "page" && !info.url.startsWith("devtools://"))
            .map((info) => ({
                targetId: info.targetId,
                url     : info.url,
                title   : info.title,
                ...(info.openerId === undefined ? {} : { openerId: info.openerId }),
                contextId:
          info.browserContextId == null || info.browserContextId === this.defaultContextId
              ? undefined
              : info.browserContextId,
            }));
    }

    async attach(targetId: string): Promise<BackendSession> {
        return wrapSession(await this.client.attach(targetId));
    }

    async attachChildren(
        session: BackendSession,
        options: ChildSessionOptions,
    ): Promise<ChildSessionHandle> {
        const peer = peers.get(session);

        if (!peer) {
            throw new DaemonError("The tab session does not support child targets.");
        }

        return ChildTargets.attach(peer, options, cdpChildTargetsDeps(this.client));
    }

    onTargetDestroyed(handler: (targetId: string) => void): () => void {
        return this.client.on("Target.targetDestroyed", (params) => {
            const parsed = destroyedSchema.safeParse(params);

            if (parsed.success) handler(parsed.data.targetId);
        });
    }

    onDisconnected(handler: () => void): () => void {
        return this.client.onClose(handler);
    }

    close(): Promise<void> {
        return this.client.close();
    }
}
