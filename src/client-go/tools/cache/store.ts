import type { KubernetesObject } from "../../../client/types";
import type { MaybePromise } from "../../../promise";

// Models staging/src/k8s.io/client-go/tools/cache/store.go KeyFunc.
export type KeyFunc<T extends KubernetesObject> = (
	obj: T | ExplicitKey,
) => MaybePromise<[key: string, err: Error | undefined]>;

// Models staging/src/k8s.io/client-go/tools/cache/delta_fifo.go TransformFunc.
export type TransformFunc<T extends KubernetesObject> = (
	obj: T,
) => MaybePromise<[obj: T, err: Error | undefined]>;

// Models staging/src/k8s.io/client-go/tools/cache/store.go StoreOption.
export type StoreOption<T extends KubernetesObject> = (cache: Cache<T>) => void;

// Models staging/src/k8s.io/client-go/tools/cache/store.go Store.
export interface Store<T extends KubernetesObject> {
	add(obj: T): MaybePromise<Error | undefined>;
	update(obj: T): MaybePromise<Error | undefined>;
	delete(obj: T): MaybePromise<Error | undefined>;
	list(): T[];
	listKeys(): string[];
	lastStoreSyncResourceVersion(): string;
	bookmark(resourceVersion: string): void;
	get(
		obj: T | ExplicitKey,
	): MaybePromise<[item: T | undefined, exists: boolean, err: Error | undefined]>;
	getByKey(
		key: string,
	): MaybePromise<[item: T | undefined, exists: boolean, err: Error | undefined]>;
	replace(list: T[], resourceVersion: string): MaybePromise<Error | undefined>;
	resync(): MaybePromise<Error | undefined>;
}

// Models staging/src/k8s.io/client-go/tools/cache/store.go KeyError.
export class KeyError<T extends KubernetesObject> extends Error {
	constructor(
		readonly obj: T | ExplicitKey,
		readonly err: Error,
	) {
		super(`couldn't create key for object ${JSON.stringify(obj)}: ${err.message}`);
	}
}

// Models staging/src/k8s.io/client-go/tools/cache/store.go ExplicitKey.
export class ExplicitKey {
	constructor(readonly key: string) {}
}

// Models staging/src/k8s.io/client-go/tools/cache/store.go cache.
class Cache<T extends KubernetesObject> implements Store<T> {
	private cacheStorage = new Map<string, T>();
	private storeSyncResourceVersion = "";
	transformer: TransformFunc<T> | undefined;

	constructor(private readonly keyFunc: KeyFunc<T>) {}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go cache.Add.
	async add(obj: T): Promise<Error | undefined> {
		const [key, err] = await this.keyFunc(obj);
		if (err) {
			return new KeyError(obj, err);
		}
		if (this.transformer) {
			const [transformedObj, transformErr] = await this.transformer(obj);
			if (transformErr) {
				return new Error(`transforming: ${transformErr.message}`);
			}
			obj = transformedObj;
		}
		this.cacheStorage.set(key, obj);
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go cache.Update.
	async update(obj: T): Promise<Error | undefined> {
		const [key, err] = await this.keyFunc(obj);
		if (err) {
			return new KeyError(obj, err);
		}
		if (this.transformer) {
			const [transformedObj, transformErr] = await this.transformer(obj);
			if (transformErr) {
				return new Error(`transforming: ${transformErr.message}`);
			}
			obj = transformedObj;
		}
		this.cacheStorage.set(key, obj);
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go cache.Delete.
	async delete(obj: T): Promise<Error | undefined> {
		const [key, err] = await this.keyFunc(obj);
		if (err) {
			return new KeyError(obj, err);
		}
		this.cacheStorage.delete(key);
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go cache.List.
	list(): T[] {
		return [...this.cacheStorage.values()];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go cache.ListKeys.
	listKeys(): string[] {
		return [...this.cacheStorage.keys()];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go cache.LastStoreSyncResourceVersion.
	lastStoreSyncResourceVersion(): string {
		return this.storeSyncResourceVersion;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go cache.Bookmark.
	bookmark(resourceVersion: string): void {
		this.storeSyncResourceVersion = resourceVersion;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go cache.Get.
	async get(
		obj: T | ExplicitKey,
	): Promise<[item: T | undefined, exists: boolean, err: Error | undefined]> {
		const [key, err] = await this.keyFunc(obj);
		if (err) {
			return [undefined, false, new KeyError(obj, err)];
		}
		return this.getByKey(key);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go cache.GetByKey.
	getByKey(key: string): [item: T | undefined, exists: boolean, err: Error | undefined] {
		const item = this.cacheStorage.get(key);
		return [item, item !== undefined, undefined];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go cache.Replace.
	async replace(list: T[], resourceVersion: string): Promise<Error | undefined> {
		const items = new Map<string, T>();
		for (const item of list) {
			const [key, err] = await this.keyFunc(item);
			if (err) {
				return new KeyError(item, err);
			}

			let obj = item;
			if (this.transformer) {
				const [transformedItem, transformErr] = await this.transformer(obj);
				if (transformErr) {
					return new Error(`transforming: ${transformErr.message}`);
				}
				obj = transformedItem;
			}
			items.set(key, obj);
		}
		this.cacheStorage = items;
		this.storeSyncResourceVersion = resourceVersion;
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go cache.Resync.
	resync(): Error | undefined {
		return undefined;
	}
}

// Models staging/src/k8s.io/client-go/tools/cache/store.go WithTransformer.
export function withTransformer<T extends KubernetesObject>(
	transformer: TransformFunc<T>,
): StoreOption<T> {
	return (cache) => {
		cache.transformer = transformer;
	};
}

// Models staging/src/k8s.io/client-go/tools/cache/store.go NewStore.
export function newStore<T extends KubernetesObject>(
	keyFunc: KeyFunc<T>,
	...opts: Array<StoreOption<T>>
): Store<T> {
	const cache = new Cache(keyFunc);
	for (const opt of opts) {
		opt(cache);
	}
	return cache;
}

// Models staging/src/k8s.io/client-go/tools/cache/store.go MetaNamespaceKeyFunc.
export function metaNamespaceKeyFunc<T extends KubernetesObject>(
	obj: T | ExplicitKey,
): [key: string, err: Error | undefined] {
	if (obj instanceof ExplicitKey) {
		return [obj.key, undefined];
	}
	const [objName, err] = objectToName(obj);
	if (err) {
		return ["", err];
	}
	return [objName.string(), undefined];
}

// Models staging/src/k8s.io/client-go/tools/cache/store.go ObjectName.
class ObjectName {
	constructor(
		readonly namespace: string,
		readonly name: string,
	) {}

	string(): string {
		if (this.namespace.length > 0) {
			return `${this.namespace}/${this.name}`;
		}
		return this.name;
	}
}

// Models staging/src/k8s.io/client-go/tools/cache/store.go ObjectToName.
function objectToName(obj: KubernetesObject): [name: ObjectName, err: Error | undefined] {
	if (!obj.metadata) {
		return [new ObjectName("", ""), new Error("object has no meta")];
	}
	return [metaObjectToName(obj), undefined];
}

// Models staging/src/k8s.io/client-go/tools/cache/store.go MetaObjectToName.
function metaObjectToName(obj: KubernetesObject): ObjectName {
	const namespace = obj.metadata?.namespace ?? "";
	const name = obj.metadata?.name ?? "";
	return new ObjectName(namespace, name);
}
