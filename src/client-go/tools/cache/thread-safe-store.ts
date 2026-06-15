/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { Index, Indices } from "./index";
import type { Transaction } from "./store";

export type ThreadSafeIndexFunc<T> = (obj: T) => [values: string[], err: Error | undefined];
export type ThreadSafeIndexers<T> = Record<string, ThreadSafeIndexFunc<T>>;

// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go ThreadSafeStoreTransaction.
export interface ThreadSafeStoreTransaction<T> extends Transaction<T> {
	key: string;
}

// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go ThreadSafeStore.
export interface ThreadSafeStore<T> {
	add(key: string, obj: T): Error | undefined;
	update(key: string, obj: T): Error | undefined;
	delete(key: string): Error | undefined;
	deleteWithObject(key: string, obj: T | undefined): Error | undefined;
	transaction(...txns: Array<ThreadSafeStoreTransaction<T>>): void;
	get(key: string): [item: T | undefined, exists: boolean];
	list(): T[];
	listKeys(): string[];
	replace(items: Map<string, T>, resourceVersion: string): Error | undefined;
	index(indexName: string, obj: T): [items: T[], err: Error | undefined];
	byIndex(indexName: string, indexedValue: string): [items: T[], err: Error | undefined];
	indexKeys(indexName: string, indexedValue: string): [keys: string[], err: Error | undefined];
	listIndexFuncValues(indexName: string): string[];
	getIndexers(): ThreadSafeIndexers<T>;
	addIndexers(newIndexers: ThreadSafeIndexers<T>): Error | undefined;
	resync(): Error | undefined;
	lastStoreSyncResourceVersion(): string;
	bookmark(resourceVersion: string): void;
}

// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go storeIndex.
export class StoreIndex<T> {
	indices: Indices;

	constructor(
		readonly indexers: ThreadSafeIndexers<T>,
		indices: Indices,
	) {
		this.indices = indices;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go storeIndex.reset.
	reset(): void {
		this.indices = new Map();
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go storeIndex.getKeysFromIndex.
	getKeysFromIndex(indexName: string, obj: T): [keys: Set<string>, err: Error | undefined] {
		const indexFunc = this.indexers[indexName];
		if (!indexFunc) {
			return [new Set(), new Error(`Index with name ${indexName} does not exist`)];
		}
		const [indexedValues, err] = indexFunc(obj);
		if (err) {
			return [new Set(), err];
		}
		const index = this.indices.get(indexName) ?? new Map();
		if (indexedValues.length === 1) {
			return [new Set(index.get(indexedValues[0] ?? "") ?? []), undefined];
		}
		const storeKeySet = new Set<string>();
		for (const indexedValue of indexedValues) {
			for (const key of index.get(indexedValue) ?? []) {
				storeKeySet.add(key);
			}
		}
		return [storeKeySet, undefined];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go storeIndex.getKeysByIndex.
	getKeysByIndex(
		indexName: string,
		indexedValue: string,
	): [keys: Set<string>, err: Error | undefined] {
		const indexFunc = this.indexers[indexName];
		if (!indexFunc) {
			return [new Set(), new Error(`Index with name ${indexName} does not exist`)];
		}
		const index = this.indices.get(indexName) ?? new Map();
		return [new Set(index.get(indexedValue) ?? []), undefined];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go storeIndex.getIndexValues.
	getIndexValues(indexName: string): string[] {
		return [...(this.indices.get(indexName)?.keys() ?? [])];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go storeIndex.addIndexers.
	addIndexers(newIndexers: ThreadSafeIndexers<T>): Error | undefined {
		const conflicts = Object.keys(newIndexers).filter((key) => this.indexers[key]);
		if (conflicts.length > 0) {
			return new Error(`indexer conflict: ${conflicts.join(",")}`);
		}
		Object.assign(this.indexers, newIndexers);
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go storeIndex.updateSingleIndex.
	updateSingleIndex(name: string, oldObj: T | undefined, newObj: T | undefined, key: string): void {
		const indexFunc = this.indexers[name];
		if (!indexFunc) {
			throw new Error(`indexer "${name}" does not exist`);
		}

		let oldIndexValues: string[] = [];
		if (oldObj) {
			const [values, err] = indexFunc(oldObj);
			if (err) {
				throw new Error(
					`unable to calculate an index entry for key "${key}" on index "${name}": ${err.message}`,
				);
			}
			oldIndexValues = values;
		}

		let indexValues: string[] = [];
		if (newObj) {
			const [values, err] = indexFunc(newObj);
			if (err) {
				throw new Error(
					`unable to calculate an index entry for key "${key}" on index "${name}": ${err.message}`,
				);
			}
			indexValues = values;
		}

		let index = this.indices.get(name);
		if (!index) {
			index = new Map();
			this.indices.set(name, index);
		}

		if (
			indexValues.length === 1 &&
			oldIndexValues.length === 1 &&
			indexValues[0] === oldIndexValues[0]
		) {
			return;
		}

		for (const value of oldIndexValues) {
			deleteKeyFromIndex(key, value, index);
		}
		for (const value of indexValues) {
			addKeyToIndex(key, value, index);
		}
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go storeIndex.updateIndices.
	updateIndices(oldObj: T | undefined, newObj: T | undefined, key: string): void {
		for (const indexName of Object.keys(this.indexers)) {
			this.updateSingleIndex(indexName, oldObj, newObj, key);
		}
	}
}

// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.
export class ThreadSafeMap<T> implements ThreadSafeStore<T> {
	readonly storeIndex: StoreIndex<T>;
	private items = new Map<string, T>();
	private rv = "";

	constructor(indexers: ThreadSafeIndexers<T>, indices: Indices) {
		this.storeIndex = new StoreIndex(indexers, indices);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.Add.
	add(key: string, obj: T): Error | undefined {
		return this.update(key, obj);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.addLocked.
	private addLocked(key: string, obj: T): void {
		this.updateLocked(key, obj);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.Update.
	update(key: string, obj: T): Error | undefined {
		const [rv, rvErr] = rvFromObject(obj);
		this.updateLocked(key, obj);
		if (!rvErr && rv !== undefined) {
			this.rv = rv;
		}
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.updateLocked.
	private updateLocked(key: string, obj: T): void {
		const oldObject = this.items.get(key);
		const storedObj = structuredClone(obj);
		this.items.set(key, storedObj);
		this.storeIndex.updateIndices(oldObject, storedObj, key);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.Delete.
	delete(key: string): Error | undefined {
		return this.deleteWithObject(key, undefined);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.DeleteWithObject.
	deleteWithObject(key: string, obj: T | undefined): Error | undefined {
		let rv: string | undefined;
		let rvErr: Error | undefined;
		if (obj !== undefined) {
			[rv, rvErr] = rvFromObject(obj);
		}
		this.deleteLocked(key);
		if (obj !== undefined && !rvErr && rv !== undefined) {
			this.rv = rv;
		}
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.deleteLocked.
	private deleteLocked(key: string): void {
		const obj = this.items.get(key);
		if (!obj) {
			return;
		}
		this.storeIndex.updateIndices(obj, undefined, key);
		this.items.delete(key);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.Transaction.
	transaction(...txns: Array<ThreadSafeStoreTransaction<T>>): void {
		if (txns.length === 0) {
			return;
		}
		const finalObj = txns[txns.length - 1]?.object;
		const [rv, rvErr] = rvFromObject(finalObj);
		for (const txn of txns) {
			switch (txn.type) {
				case "add":
					this.addLocked(txn.key, txn.object);
					break;
				case "update":
					this.updateLocked(txn.key, txn.object);
					break;
				case "delete":
					this.deleteLocked(txn.key);
					break;
			}
		}
		if (!rvErr && rv !== undefined) {
			this.rv = rv;
		}
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.Get.
	get(key: string): [item: T | undefined, exists: boolean] {
		const item = this.items.get(key);
		return [item === undefined ? undefined : structuredClone(item), item !== undefined];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.List.
	list(): T[] {
		return [...this.items.values()].map((item) => structuredClone(item));
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.ListKeys.
	listKeys(): string[] {
		return [...this.items.keys()];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.Replace.
	replace(items: Map<string, T>, resourceVersion: string): Error | undefined {
		this.items = new Map([...items].map(([key, item]) => [key, structuredClone(item)]));
		this.rv = resourceVersion;
		this.storeIndex.reset();
		for (const [key, item] of this.items) {
			this.storeIndex.updateIndices(undefined, item, key);
		}
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.Index.
	index(indexName: string, obj: T): [items: T[], err: Error | undefined] {
		const [storeKeySet, err] = this.storeIndex.getKeysFromIndex(indexName, obj);
		if (err) {
			return [[], err];
		}
		const list: T[] = [];
		for (const storeKey of storeKeySet) {
			const item = this.items.get(storeKey);
			if (item) {
				list.push(structuredClone(item));
			}
		}
		return [list, undefined];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.ByIndex.
	byIndex(indexName: string, indexedValue: string): [items: T[], err: Error | undefined] {
		const [set, err] = this.storeIndex.getKeysByIndex(indexName, indexedValue);
		if (err) {
			return [[], err];
		}
		const list: T[] = [];
		for (const key of set) {
			const item = this.items.get(key);
			if (item) {
				list.push(structuredClone(item));
			}
		}
		return [list, undefined];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.IndexKeys.
	indexKeys(indexName: string, indexedValue: string): [keys: string[], err: Error | undefined] {
		const [set, err] = this.storeIndex.getKeysByIndex(indexName, indexedValue);
		if (err) {
			return [[], err];
		}
		return [[...set], undefined];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.ListIndexFuncValues.
	listIndexFuncValues(indexName: string): string[] {
		return this.storeIndex.getIndexValues(indexName);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.GetIndexers.
	getIndexers(): ThreadSafeIndexers<T> {
		return this.storeIndex.indexers;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.AddIndexers.
	addIndexers(newIndexers: ThreadSafeIndexers<T>): Error | undefined {
		const err = this.storeIndex.addIndexers(newIndexers);
		if (err) {
			return err;
		}
		for (const [key, item] of this.items) {
			for (const name of Object.keys(newIndexers)) {
				this.storeIndex.updateSingleIndex(name, undefined, item, key);
			}
		}
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.Resync.
	resync(): Error | undefined {
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.LastStoreSyncResourceVersion.
	lastStoreSyncResourceVersion(): string {
		return this.rv;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go threadSafeMap.Bookmark.
	bookmark(resourceVersion: string): void {
		this.rv = resourceVersion;
	}
}

// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go NewThreadSafeStore.
export function newThreadSafeStore<T>(
	indexers: ThreadSafeIndexers<T>,
	indices: Indices,
): ThreadSafeStore<T> {
	return new ThreadSafeMap(indexers, indices);
}

// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go addKeyToIndex.
function addKeyToIndex(key: string, indexValue: string, index: Index): void {
	let set = index.get(indexValue);
	if (!set) {
		set = new Set();
		index.set(indexValue, set);
	}
	set.add(key);
}

// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go deleteKeyFromIndex.
function deleteKeyFromIndex(key: string, indexValue: string, index: Index): void {
	const set = index.get(indexValue);
	if (!set) {
		return;
	}
	set.delete(key);
	if (set.size === 0) {
		index.delete(indexValue);
	}
}

// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store.go rvFromObject.
function rvFromObject(obj: unknown): [rv: string | undefined, err: Error | undefined] {
	if (!obj || typeof obj !== "object") {
		return [undefined, undefined];
	}
	if ("resourceVersion" in obj && typeof obj.resourceVersion === "string") {
		return [obj.resourceVersion, undefined];
	}
	if ("metadata" in obj) {
		const metadata = obj.metadata;
		if (
			metadata &&
			typeof metadata === "object" &&
			"resourceVersion" in metadata &&
			typeof metadata.resourceVersion === "string"
		) {
			return [metadata.resourceVersion, undefined];
		}
	}
	return [undefined, undefined];
}
