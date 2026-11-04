import { RpcError } from "./errors.js";
import { ErrorCode } from "./protocol.js";

// The browser records one trace at a time for everyone, so one session at a time may hold it.
export class TraceLock {
    private owner: { holder: object; targetId: string } | undefined;

    acquire(holder: object, targetId: string): void {
        if (this.owner === undefined) {
            this.owner = { holder, targetId };

            return;
        }

        throw new RpcError(
            ErrorCode.busy,
            this.owner.holder === holder
                ? "A trace is already recording in this session. Stop it first."
                : "Another session is recording a trace. Try again when it has stopped.",
        );
    }

    targetOf(holder: object): string | undefined {
        return this.owner?.holder === holder ? this.owner.targetId : undefined;
    }

    release(holder: object, targetId?: string): void {
        if (this.owner?.holder !== holder) return;

        if (targetId !== undefined && this.owner.targetId !== targetId) return;

        this.owner = undefined;
    }
}
