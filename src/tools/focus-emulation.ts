import type { DaemonAccess } from "../mcp/index.js";
import { ToolError } from "./errors.js";

export class FocusEmulation {
    private readonly tabs = new Set<string>();
    private readonly pending = new Map<string, Set<symbol>>();

    enabled(tab: string): boolean {
        return this.tabs.has(tab);
    }

    async ensure(access: DaemonAccess, tab: string): Promise<void> {
        if (this.tabs.has(tab)) return;

        const operations = this.pending.get(tab) ?? new Set<symbol>();
        const token = Symbol();

        operations.add(token);
        this.pending.set(tab, operations);

        try {
            await access.send({
                targetId: tab,
                method  : "Emulation.setFocusEmulationEnabled",
                params  : { enabled: true },
            });

            if (this.pending.get(tab) !== operations) {
                throw new ToolError("The tab closed or the session reset while enabling focus emulation.");
            }

            this.tabs.add(tab);
        } finally {
            operations.delete(token);

            if (operations.size === 0 && this.pending.get(tab) === operations) {
                this.pending.delete(tab);
            }
        }
    }

    forget(tab: string): void {
        this.tabs.delete(tab);
        this.pending.delete(tab);
    }

    reset(): void {
        this.tabs.clear();
        this.pending.clear();
    }
}
