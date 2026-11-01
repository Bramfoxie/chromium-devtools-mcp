import type { DaemonAccess } from "../mcp/index.js";

export class FocusEmulation {
    private readonly tabs = new Set<string>();

    enabled(tab: string): boolean {
        return this.tabs.has(tab);
    }

    async ensure(access: DaemonAccess, tab: string): Promise<void> {
        if (this.tabs.has(tab)) return;

        await access.send(tab, "Emulation.setFocusEmulationEnabled", { enabled: true });
        this.tabs.add(tab);
    }

    forget(tab: string): void {
        this.tabs.delete(tab);
    }

    reset(): void {
        this.tabs.clear();
    }
}
