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

    peek(key: K): V | undefined {
        return this.map.get(key);
    }

    touch(key: K, value: V): void {
        this.map.delete(key);
        this.map.set(key, value);
    }

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

    clear(): void {
        if (this.onEvict) {
            for (const key of [...this.map.keys()]) this.delete(key);
        } else {
            this.map.clear();
        }
    }
}
