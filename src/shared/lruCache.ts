/**
 * Shared least recently used cache over Map insertion order.
 */

/** Options for one LRU cache instance. */
export interface LruCacheOptions<K, V> {
    /** Entries before the least recently used is evicted. */
    maxEntries: number;
    /** Called with the evicted value, used to release byte budgets. */
    onEvict?: (key: K, value: V) => void;
}

export class LruCache<K, V> {
    private readonly map = new Map<K, V>();
    private readonly maxEntries: number;
    private readonly onEvict?: (key: K, value: V) => void;

    constructor(options: LruCacheOptions<K, V>) {
        this.maxEntries = options.maxEntries;
        this.onEvict = options.onEvict;
    }

    /** Number of cached entries. */
    get size(): number {
        return this.map.size;
    }

    /** Look up without marking the entry as recently used. */
    peek(key: K): V | undefined {
        return this.map.get(key);
    }

    /** Reinsert a value the caller already holds to mark it recently used. */
    touch(key: K, value: V): void {
        this.map.delete(key);
        this.map.set(key, value);
    }

    /** Insert or replace an entry, then evict over capacity. */
    set(key: K, value: V): this {
        if (this.onEvict) {
            const previous = this.map.get(key);
            if (previous !== undefined) this.onEvict(key, previous);
        }
        this.map.delete(key);
        this.map.set(key, value);
        this.evictToCapacity();
        return this;
    }

    /** Remove one entry, returns whether it was present. */
    delete(key: K): boolean {
        if (this.onEvict) {
            const value = this.map.get(key);
            if (value === undefined) return false;
            this.map.delete(key);
            this.onEvict(key, value);
            return true;
        }
        return this.map.delete(key);
    }

    /** Evict the least recently used entry regardless of capacity, false when empty. */
    evictOldest(): boolean {
        const oldest = this.map.keys().next().value;
        if (oldest === undefined) return false;
        if (this.onEvict) {
            const value = this.map.get(oldest) as V;
            this.map.delete(oldest);
            this.onEvict(oldest, value);
        } else {
            this.map.delete(oldest);
        }
        return true;
    }

    /** Evict until size fits, called after each set. */
    evictToCapacity(): void {
        while (this.map.size > this.maxEntries) {
            if (!this.evictOldest()) break;
        }
    }

    /** Keys from least to most recently used, snapshot before removing while iterating. */
    keys(): IterableIterator<K> {
        return this.map.keys();
    }

    /** Values from least to most recently used, read only. */
    values(): IterableIterator<V> {
        return this.map.values();
    }

    /** Drop every entry, onEvict runs per entry. */
    clear(): void {
        if (this.onEvict) {
            for (const key of [...this.map.keys()]) this.delete(key);
        } else {
            this.map.clear();
        }
    }
}
