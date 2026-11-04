interface RingBufferOptions<T> {
    maxEntries: number;
    maxBytes  : number;
    sizeOf    : (value: T) => number;
    onEvict?  : (id: number, value: T) => void;
}

export class RingBuffer<T> {
    private readonly maxEntries: number;
    private readonly maxBytes  : number;
    private readonly sizeOf    : (value: T) => number;
    private readonly onEvict   : ((id: number, value: T) => void) | undefined;
    private readonly entries = new Map<number, { value: T; size: number }>();
    private nextId  = 1;
    private used    = 0;
    private evicted = 0;

    constructor(options: RingBufferOptions<T>) {
        this.maxEntries = Math.max(1, Math.floor(options.maxEntries));
        this.maxBytes = Math.max(1, Math.floor(options.maxBytes));
        this.sizeOf = options.sizeOf;
        this.onEvict = options.onEvict;
    }

    get size(): number {
        return this.entries.size;
    }

    get bytes(): number {
        return this.used;
    }

    get dropped(): number {
        return this.evicted;
    }

    get lastId(): number {
        return this.nextId - 1;
    }

    push(value: T): number {
        const id = this.nextId;
        const size = Math.max(0, this.sizeOf(value));

        this.nextId += 1;
        this.entries.set(id, { value, size });
        this.used += size;
        this.evictWhileOver();

        return id;
    }

    get(id: number): T | undefined {
        return this.entries.get(id)?.value;
    }

    adjust(id: number, delta: number): void {
        const entry = this.entries.get(id);

        if (entry === undefined) return;

        entry.size = Math.max(0, entry.size + delta);
        this.used = Math.max(0, this.used + delta);
        this.evictWhileOver();
    }

    after(afterId: number, limit: number): Array<{ id: number; value: T }> {
        const found: Array<{ id: number; value: T }> = [];

        for (const [id, entry] of this.entries) {
            if (id <= afterId) continue;

            found.push({ id, value: entry.value });

            if (found.length >= limit) break;
        }

        return found;
    }

    clear(): void {
        this.entries.clear();
        this.used = 0;
        this.evicted = 0;
    }

    private evictWhileOver(): void {
        while (
            (this.entries.size > this.maxEntries || this.used > this.maxBytes) &&
            this.entries.size > 0
        ) {
            const oldest = this.entries.keys().next().value as number;
            const entry = this.entries.get(oldest) as { value: T; size: number };

            this.entries.delete(oldest);
            this.used = Math.max(0, this.used - entry.size);
            this.evicted += 1;
            this.onEvict?.(oldest, entry.value);
        }
    }
}
