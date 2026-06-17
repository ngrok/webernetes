/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { PassiveClock } from "../../../utils/clock/clock";
import type { SendChannel } from "../../../go/channel";
import { ExpirationCache, type ExpirationPolicy, type TimestampedEntry } from "./expiration-cache";
import type { KeyFunc, Store } from "./store";
import {
	newThreadSafeStore,
	type ThreadSafeIndexers,
	type ThreadSafeStore,
	type ThreadSafeStoreTransaction,
} from "./thread-safe-store";

// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache_fakes.go fakeThreadSafeMap.
class FakeThreadSafeMap<T> implements ThreadSafeStore<T> {
	constructor(
		private readonly threadSafeStore: ThreadSafeStore<T>,
		private readonly deletedKeys?: SendChannel<string>,
	) {}

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache_fakes.go fakeThreadSafeMap.Delete.
	delete(key: string): Error | undefined {
		if (this.deletedKeys) {
			const err = this.threadSafeStore.delete(key);
			this.deletedKeys.trySend(key);
			return err;
		}
		return undefined;
	}

	add(key: string, obj: T): Error | undefined {
		return this.threadSafeStore.add(key, obj);
	}

	update(key: string, obj: T): Error | undefined {
		return this.threadSafeStore.update(key, obj);
	}

	deleteWithObject(key: string, obj: T | undefined): Error | undefined {
		return this.threadSafeStore.deleteWithObject(key, obj);
	}

	transaction(...txns: Array<ThreadSafeStoreTransaction<T>>): void {
		this.threadSafeStore.transaction(...txns);
	}

	get(key: string): [item: T | undefined, exists: boolean] {
		return this.threadSafeStore.get(key);
	}

	list(): T[] {
		return this.threadSafeStore.list();
	}

	listKeys(): string[] {
		return this.threadSafeStore.listKeys();
	}

	replace(items: Map<string, T>, resourceVersion: string): Error | undefined {
		return this.threadSafeStore.replace(items, resourceVersion);
	}

	index(indexName: string, obj: T): [items: T[], err: Error | undefined] {
		return this.threadSafeStore.index(indexName, obj);
	}

	byIndex(indexName: string, indexedValue: string): [items: T[], err: Error | undefined] {
		return this.threadSafeStore.byIndex(indexName, indexedValue);
	}

	indexKeys(indexName: string, indexedValue: string): [keys: string[], err: Error | undefined] {
		return this.threadSafeStore.indexKeys(indexName, indexedValue);
	}

	listIndexFuncValues(indexName: string): string[] {
		return this.threadSafeStore.listIndexFuncValues(indexName);
	}

	getIndexers(): ThreadSafeIndexers<T> {
		return this.threadSafeStore.getIndexers();
	}

	addIndexers(newIndexers: ThreadSafeIndexers<T>): Error | undefined {
		return this.threadSafeStore.addIndexers(newIndexers);
	}

	resync(): Error | undefined {
		return this.threadSafeStore.resync();
	}

	lastStoreSyncResourceVersion(): string {
		return this.threadSafeStore.lastStoreSyncResourceVersion();
	}

	bookmark(resourceVersion: string): void {
		this.threadSafeStore.bookmark(resourceVersion);
	}
}

// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache_fakes.go FakeExpirationPolicy.
export class FakeExpirationPolicy<T> implements ExpirationPolicy<T> {
	constructor(
		readonly neverExpire: Set<string>,
		readonly retrieveKeyFunc: (obj: TimestampedEntry<T>) => [string, Error | undefined],
	) {}

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache_fakes.go FakeExpirationPolicy.IsExpired.
	isExpired(obj: TimestampedEntry<T>): boolean {
		const [key] = this.retrieveKeyFunc(obj);
		return !this.neverExpire.has(key);
	}
}

// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache_fakes.go NewFakeExpirationStore.
export function newFakeExpirationStore<T>(
	keyFunc: KeyFunc<T>,
	deletedKeys: SendChannel<string> | undefined,
	expirationPolicy: ExpirationPolicy<T>,
	cacheClock: PassiveClock,
): Store<T> {
	const cacheStorage = newThreadSafeStore<TimestampedEntry<T>>({}, new Map());
	return new ExpirationCache(
		keyFunc,
		cacheClock,
		expirationPolicy,
		new FakeThreadSafeMap(cacheStorage, deletedKeys),
	);
}
