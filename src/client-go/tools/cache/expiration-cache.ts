/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { PassiveClock } from "../../../utils/clock/clock";
import { ExplicitKey, KeyError, type KeyFunc, type Store } from "./store";
import { newThreadSafeStore, type ThreadSafeStore } from "./thread-safe-store";

// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache.go ExpirationPolicy.
export interface ExpirationPolicy<T> {
	isExpired(obj: TimestampedEntry<T>): boolean;
}

// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache.go TTLPolicy.
export class TTLPolicy<T> implements ExpirationPolicy<T> {
	constructor(
		public ttl: number,
		readonly clock: PassiveClock,
	) {}

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache.go TTLPolicy.IsExpired.
	isExpired(obj: TimestampedEntry<T>): boolean {
		return this.ttl > 0 && this.clock.since(obj.timestamp) > this.ttl;
	}
}

// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache.go TimestampedEntry.
export class TimestampedEntry<T> {
	constructor(
		readonly obj: T,
		readonly timestamp: Date,
		readonly key: string,
	) {}
}

// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache.go ExpirationCache.
export class ExpirationCache<T> implements Store<T> {
	constructor(
		private readonly keyFunc: KeyFunc<T>,
		private readonly clock: PassiveClock,
		private readonly expirationPolicy: ExpirationPolicy<T>,
		private readonly cacheStorage: ThreadSafeStore<TimestampedEntry<T>> = newThreadSafeStore(
			{},
			new Map(),
		),
	) {}

	private getTimestampedEntry(key: string): [TimestampedEntry<T> | undefined, boolean] {
		return this.cacheStorage.get(key);
	}

	private getOrExpire(key: string): [T | undefined, boolean] {
		const [timestampedItem, exists] = this.getTimestampedEntry(key);
		if (!exists || !timestampedItem) {
			return [undefined, false];
		}
		if (this.expirationPolicy.isExpired(timestampedItem)) {
			this.cacheStorage.delete(key);
			return [undefined, false];
		}
		return [timestampedItem.obj, true];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache.go ExpirationCache.GetByKey.
	getByKey(key: string): [item: T | undefined, exists: boolean, err: Error | undefined] {
		const [obj, exists] = this.getOrExpire(key);
		return [obj, exists, undefined];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache.go ExpirationCache.Get.
	async get(
		obj: T | ExplicitKey,
	): Promise<[item: T | undefined, exists: boolean, err: Error | undefined]> {
		const [key, err] = await this.keyFunc(obj);
		if (err) {
			return [undefined, false, new KeyError(obj, err)];
		}
		const [o, exists] = this.getOrExpire(key);
		return [o, exists, undefined];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache.go ExpirationCache.List.
	list(): T[] {
		const items = this.cacheStorage.list();
		const list: T[] = [];
		for (const item of items) {
			const [obj, exists] = this.getOrExpire(item.key);
			if (exists && obj) {
				list.push(obj);
			}
		}
		return list;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache.go ExpirationCache.LastStoreSyncResourceVersion.
	lastStoreSyncResourceVersion(): string {
		return this.cacheStorage.lastStoreSyncResourceVersion();
	}

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache.go ExpirationCache.Bookmark.
	bookmark(resourceVersion: string): void {
		this.cacheStorage.bookmark(resourceVersion);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache.go ExpirationCache.ListKeys.
	listKeys(): string[] {
		return this.cacheStorage.listKeys();
	}

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache.go ExpirationCache.Add.
	async add(obj: T): Promise<Error | undefined> {
		const [key, err] = await this.keyFunc(obj);
		if (err) {
			return new KeyError(obj, err);
		}
		return this.cacheStorage.add(key, new TimestampedEntry(obj, this.clock.now(), key));
	}

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache.go ExpirationCache.Update.
	async update(obj: T): Promise<Error | undefined> {
		return await this.add(obj);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache.go ExpirationCache.Delete.
	async delete(obj: T): Promise<Error | undefined> {
		const [key, err] = await this.keyFunc(obj);
		if (err) {
			return new KeyError(obj, err);
		}
		return this.cacheStorage.deleteWithObject(
			key,
			new TimestampedEntry(obj, this.clock.now(), key),
		);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache.go ExpirationCache.Replace.
	async replace(list: T[], resourceVersion: string): Promise<Error | undefined> {
		const items = new Map<string, TimestampedEntry<T>>();
		const ts = this.clock.now();
		for (const item of list) {
			const [key, err] = await this.keyFunc(item);
			if (err) {
				return new KeyError(item, err);
			}
			items.set(key, new TimestampedEntry(item, ts, key));
		}
		return this.cacheStorage.replace(items, resourceVersion);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache.go ExpirationCache.Resync.
	resync(): Error | undefined {
		return undefined;
	}
}
