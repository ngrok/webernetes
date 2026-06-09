/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { KeyFnMap } from "./collections";

export type Key = string | number | boolean | symbol | object;
export type EvictionFunc<K extends Key, V> = (key: K, value: V) => void;

interface Entry<K extends Key, V> {
	key: K;
	value: V;
}

// Models k8s.io/utils/lru/lru.go Cache.
export class Cache<K extends Key, V> {
	private readonly cache = new KeyFnMap<K, Entry<K, V>>();
	private onEvicted: EvictionFunc<K, V> | undefined;

	// A maxEntries of 0 means no limit.
	constructor(private readonly maxEntries: number) {}

	// Models k8s.io/utils/lru/lru.go NewWithEvictionFunc.
	static withEvictionFunc<K extends Key, V>(size: number, f: EvictionFunc<K, V>): Cache<K, V> {
		const cache = new Cache<K, V>(size);
		cache.onEvicted = f;
		return cache;
	}

	// Models k8s.io/utils/lru/lru.go Cache.SetEvictionFunc.
	setEvictionFunc(f: EvictionFunc<K, V>): Error | undefined {
		if (this.onEvicted !== undefined) {
			return new Error("lru cache eviction function is already set");
		}
		this.onEvicted = f;
		return undefined;
	}

	// Models k8s.io/utils/lru/lru.go Cache.Add.
	add(key: K, value: V): void {
		// Delete and reinsert the entry to preserve Go's MoveToFront semantics.
		// KeyFnMap gives us Go-like value equality for struct-shaped keys.
		if (this.cache.has(key)) {
			this.cache.delete(key);
		}
		this.cache.set(key, { key, value });
		if (this.maxEntries !== 0 && this.cache.size > this.maxEntries) {
			this.removeOldest();
		}
	}

	// Models k8s.io/utils/lru/lru.go Cache.Get.
	get(key: K): [value: V | undefined, ok: boolean] {
		const entry = this.cache.get(key);
		if (entry === undefined) {
			return [undefined, false];
		}
		// Delete and reinsert the entry to preserve Go's MoveToFront semantics.
		// KeyFnMap gives us Go-like value equality for struct-shaped keys.
		this.cache.delete(key);
		this.cache.set(key, entry);
		return [entry.value, true];
	}

	// Models k8s.io/utils/lru/lru.go Cache.Remove.
	remove(key: K): void {
		const entry = this.cache.get(key);
		if (entry === undefined) {
			return;
		}
		this.cache.delete(key);
		this.onEvicted?.(entry.key, entry.value);
	}

	// Models k8s.io/utils/lru/lru.go Cache.RemoveOldest.
	removeOldest(): void {
		// KeyFnMap preserves insertion order through its backing Map. ECMA-262
		// specifies Map.prototype.set appends new entries to [[MapData]] and
		// Map.prototype.values creates an iterator that walks [[MapData]] from
		// index 0 upward. See ECMA-262 24.1.3.11 and 24.1.5.1.
		const oldest = this.cache.values().next().value;
		if (oldest === undefined) {
			return;
		}
		this.cache.delete(oldest.key);
		this.onEvicted?.(oldest.key, oldest.value);
	}

	// Models k8s.io/utils/lru/lru.go Cache.Len.
	len(): number {
		return this.cache.size;
	}

	// Models k8s.io/utils/lru/lru.go Cache.Clear.
	clear(): void {
		if (this.onEvicted) {
			for (const entry of this.cache.values()) {
				this.onEvicted(entry.key, entry.value);
			}
		}
		this.cache.clear();
	}
}

// Models k8s.io/utils/lru/lru.go New.
export function newLRU<K extends Key, V>(size: number): Cache<K, V> {
	return new Cache<K, V>(size);
}

// Models k8s.io/utils/lru/lru.go NewWithEvictionFunc.
export function newLRUWithEvictionFunc<K extends Key, V>(
	size: number,
	f: EvictionFunc<K, V>,
): Cache<K, V> {
	return Cache.withEvictionFunc(size, f);
}
