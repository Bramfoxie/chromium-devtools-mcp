import type { CdpClient, EventHandler, SessionSendOptions } from "./client.js";

export class CdpSession {
    constructor(
        private readonly client: CdpClient,
        readonly sessionId     : string,
        readonly targetId      : string,
    ) {}

    send(method: string, params?: object, options: SessionSendOptions = {}): Promise<unknown> {
        return this.client.send(method, params, { ...options, sessionId: this.sessionId });
    }

    on(event: string, handler: EventHandler): () => void {
        return this.client.on(event, handler, this.sessionId);
    }

    async detach(): Promise<void> {
        try {
            await this.client.send("Target.detachFromTarget", { sessionId: this.sessionId });
        } finally {
            this.client.dropSession(this.sessionId);
        }
    }
}
