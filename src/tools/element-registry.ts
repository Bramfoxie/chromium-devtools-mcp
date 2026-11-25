export const MAX_UIDS_PER_TAB = 5000;

export const STALE_UID_MESSAGE =
    "This element id is stale. Take a new dom_snapshot or run dom_query again.";

export interface ElementNode {
    backendNodeId   : number;
    frameId?        : string;
    isolated?       : boolean;
    frameGeneration?: number;
}

export interface ResolvedElement extends ElementNode {
    objectId: string;
}

const UID_PATTERN = /^(\d+)_(\d+)$/;

interface TabElements {
    generation: number;
    uids      : Map<string, ElementNode>;
    byNode    : Map<string, string>;
}

function nodeKeyOf(node: ElementNode | undefined): string {
    if (node === undefined) return "";

    return `${node.backendNodeId}|${node.frameId ?? ""}`;
}

export class ElementRegistry {
    private readonly tabs = new Map<string, TabElements>();
    private generationFloor = 0;
    private highestGeneration = 0;
    private nextUid = 0;

    generation(tab: string): number {
        return this.state(tab).generation;
    }

    nextGeneration(tab: string): number {
        const state = this.state(tab);

        state.generation += 1;
        this.highestGeneration = Math.max(this.highestGeneration, state.generation);
        state.uids.clear();
        state.byNode.clear();

        return state.generation;
    }

    assign(tab: string, nodes: ElementNode[]): Array<string | undefined> {
        const state = this.state(tab);

        return nodes.map((node) => {
            const key = `${node.backendNodeId}|${node.frameId ?? ""}`;
            const known = state.byNode.get(key);

            if (known !== undefined && state.uids.has(known)) return known;

            if (state.uids.size >= MAX_UIDS_PER_TAB) {
                const oldest = state.uids.keys().next();

                if (oldest.done === true) return undefined;

                state.byNode.delete(nodeKeyOf(state.uids.get(oldest.value)));
                state.uids.delete(oldest.value);
            }

            this.nextUid += 1;
            const uid = `${state.generation}_${this.nextUid}`;

            state.uids.set(uid, { ...node });
            state.byNode.set(key, uid);

            return uid;
        });
    }

    lookup(
        tab             : string,
        uid             : string,
        frameGeneration?: (frameId: string) => number,
    ): ElementNode | undefined {
        const state = this.tabs.get(tab);
        const generation = state === undefined ? undefined : UID_PATTERN.exec(uid)?.[1];

        if (state === undefined || generation === undefined) return undefined;
        if (Number(generation) !== state.generation) return undefined;

        const found = state.uids.get(uid);

        if (found === undefined) return undefined;

        if (
            found.frameId !== undefined && found.frameGeneration !== undefined &&
            frameGeneration !== undefined &&
            frameGeneration(found.frameId) !== found.frameGeneration
        ) {
            return undefined;
        }

        return { ...found };
    }

    invalidateFrame(tab: string, frameId: string): void {
        const state = this.tabs.get(tab);

        if (state === undefined) return;

        for (const [uid, node] of state.uids) {
            if (node.frameId === frameId) {
                state.byNode.delete(nodeKeyOf(node));
                state.uids.delete(uid);
            }
        }
    }

    forget(tab: string): void {
        if (this.tabs.delete(tab)) this.advanceFloor();
    }

    reset(): void {
        if (this.tabs.size > 0) this.advanceFloor();

        this.tabs.clear();
    }

    private advanceFloor(): void {
        this.generationFloor = this.highestGeneration + 1;
        this.highestGeneration = this.generationFloor;
    }

    private state(tab: string): TabElements {
        let state = this.tabs.get(tab);

        if (!state) {
            state = {
                generation: this.generationFloor,
                uids      : new Map(),
                byNode    : new Map(),
            };
            this.tabs.set(tab, state);
        }

        return state;
    }
}
