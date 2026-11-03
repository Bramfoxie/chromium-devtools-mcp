export class WebAuthnState {
    private readonly tabs = new Map<string, Set<string>>();

    ids(tab: string): string[] {
        return [...(this.tabs.get(tab) ?? [])];
    }

    has(tab: string, authenticatorId: string): boolean {
        return this.tabs.get(tab)?.has(authenticatorId) ?? false;
    }

    add(tab: string, authenticatorId: string): void {
        const ids = this.tabs.get(tab) ?? new Set<string>();

        ids.add(authenticatorId);
        this.tabs.set(tab, ids);
    }

    // Returns how many authenticators the tab still has.
    remove(tab: string, authenticatorId: string): number {
        const ids = this.tabs.get(tab);

        ids?.delete(authenticatorId);

        if (ids !== undefined && ids.size === 0) this.tabs.delete(tab);

        return ids?.size ?? 0;
    }

    forget(tab: string): void {
        this.tabs.delete(tab);
    }

    reset(): void {
        this.tabs.clear();
    }
}
