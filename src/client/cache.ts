import { Watch } from "./watch";
import {
	ADD,
	CHANGE,
	CONNECT,
	DELETE,
	ERROR,
	type ErrorCallback,
	type Informer,
	type ListPromise,
	type ObjectCallback,
	UPDATE,
} from "./informer";
import type { KubernetesObject } from "./types";

export interface ObjectCache<T> {
	get(name: string, namespace?: string): T | undefined;
	list(namespace?: string): ReadonlyArray<T>;
}

export type CacheMap<T extends KubernetesObject> = Map<string, Map<string, T>>;

type CallbackMap<T extends KubernetesObject> = {
	[ADD]: Array<ObjectCallback<T>>;
	[UPDATE]: Array<ObjectCallback<T>>;
	[DELETE]: Array<ObjectCallback<T>>;
	[ERROR]: Array<ErrorCallback>;
	[CONNECT]: Array<ErrorCallback>;
};

interface HttpError extends Error {
	statusCode?: number;
	code?: number;
}

export class ListWatch<T extends KubernetesObject> implements ObjectCache<T>, Informer<T> {
	private objects: CacheMap<T> = new Map();
	private resourceVersion = "";
	private readonly indexCache = {};
	private readonly callbackCache: CallbackMap<T>;
	private request?: AbortController;
	private stopped = false;

	public constructor(
		private readonly path: string,
		private readonly watch: Watch,
		private readonly listFn: ListPromise<T>,
		autoStart = true,
		private readonly labelSelector?: string,
		private readonly fieldSelector?: string,
	) {
		this.callbackCache = {
			[ADD]: [],
			[UPDATE]: [],
			[DELETE]: [],
			[ERROR]: [],
			[CONNECT]: [],
		};

		void this.indexCache;

		if (autoStart) {
			void this.doneHandler(null);
		}
	}

	public async start(): Promise<void> {
		this.stopped = false;
		await this.doneHandler(null);
	}

	public async stop(): Promise<void> {
		this.stopped = true;
		this.stopRequest();
	}

	public on(
		verb: typeof ADD | typeof UPDATE | typeof DELETE | typeof CHANGE,
		cb: ObjectCallback<T>,
	): void;
	public on(verb: typeof ERROR | typeof CONNECT, cb: ErrorCallback): void;
	public on(
		verb:
			| typeof ADD
			| typeof UPDATE
			| typeof DELETE
			| typeof CHANGE
			| typeof ERROR
			| typeof CONNECT,
		cb: ObjectCallback<T> | ErrorCallback,
	): void {
		if (verb === CHANGE) {
			this.on(ADD, cb);
			this.on(UPDATE, cb);
			this.on(DELETE, cb);
			return;
		}

		if (!(verb in this.callbackCache)) {
			throw new Error(`Unknown verb: ${verb}`);
		}

		if (verb === ERROR || verb === CONNECT) {
			this.callbackCache[verb].push(cb as ErrorCallback);
			return;
		}

		this.callbackCache[verb].push(cb);
	}

	public off(
		verb: typeof ADD | typeof UPDATE | typeof DELETE | typeof CHANGE,
		cb: ObjectCallback<T>,
	): void;
	public off(verb: typeof ERROR | typeof CONNECT, cb: ErrorCallback): void;
	public off(
		verb:
			| typeof ADD
			| typeof UPDATE
			| typeof DELETE
			| typeof CHANGE
			| typeof ERROR
			| typeof CONNECT,
		cb: ObjectCallback<T> | ErrorCallback,
	): void {
		if (verb === CHANGE) {
			this.off(ADD, cb);
			this.off(UPDATE, cb);
			this.off(DELETE, cb);
			return;
		}

		if (!(verb in this.callbackCache)) {
			throw new Error(`Unknown verb: ${verb}`);
		}

		const callbacks =
			verb === ERROR || verb === CONNECT
				? this.callbackCache[verb]
				: this.callbackCache[verb as typeof ADD | typeof UPDATE | typeof DELETE];
		const index = callbacks.findIndex((cachedCallback) => cachedCallback === cb);
		if (index >= 0) {
			callbacks.splice(index, 1);
		}
	}

	public get(name: string, namespace?: string): T | undefined {
		return this.objects.get(namespace ?? "")?.get(name);
	}

	public list(namespace?: string): ReadonlyArray<T> {
		if (!namespace) {
			const objects: T[] = [];
			for (const namespaceObjects of this.objects.values()) {
				objects.push(...namespaceObjects.values());
			}
			return objects;
		}

		return Array.from(this.objects.get(namespace ?? "")?.values() ?? []);
	}

	public latestResourceVersion(): string {
		return this.resourceVersion;
	}

	private stopRequest(): void {
		this.request?.abort();
		this.request = undefined;
	}

	private async doneHandler(err: unknown): Promise<void> {
		this.stopRequest();

		if (isGoneError(err)) {
			this.resourceVersion = "";
		} else if (err) {
			for (const callback of this.callbackCache[ERROR]) {
				callback(err);
			}
			return;
		}

		if (this.stopped) {
			return;
		}

		for (const callback of this.callbackCache[CONNECT]) {
			callback(undefined);
		}

		if (!this.resourceVersion) {
			let list;
			try {
				list = await this.listFn();
			} catch (error) {
				for (const callback of this.callbackCache[ERROR]) {
					callback(error);
				}
				return;
			}

			this.objects = deleteItems(this.objects, list.items, [...this.callbackCache[DELETE]]);
			this.addOrUpdateItems(list.items);
			this.resourceVersion = list.metadata?.resourceVersion ?? "";
		}

		const queryParams: Record<string, string> = {
			resourceVersion: this.resourceVersion,
		};

		if (this.labelSelector !== undefined) {
			queryParams.labelSelector = this.labelSelector;
		}

		if (this.fieldSelector !== undefined) {
			queryParams.fieldSelector = this.fieldSelector;
		}

		this.request = await this.watch.watch(
			this.path,
			queryParams,
			this.watchHandler.bind(this),
			this.doneHandler.bind(this),
		);
	}

	private addOrUpdateItems(items: T[] | undefined | null): void {
		if (!items) {
			return;
		}

		for (const item of items) {
			addOrUpdateObject(
				this.objects,
				item,
				[...this.callbackCache[ADD]],
				[...this.callbackCache[UPDATE]],
			);
		}
	}

	private async watchHandler(phase: string, obj: unknown): Promise<void> {
		const object = obj as T & { code?: number };

		switch (phase) {
			case "ERROR":
				if (object.code === 410) {
					this.resourceVersion = "";
				}
				return;
			case "ADDED":
			case "MODIFIED":
				if (
					!addOrUpdateObject(
						this.objects,
						object,
						[...this.callbackCache[ADD]],
						[...this.callbackCache[UPDATE]],
					)
				) {
					return;
				}
				break;
			case "DELETED":
				deleteObject(this.objects, object, [...this.callbackCache[DELETE]]);
				break;
			case "BOOKMARK":
				break;
		}

		this.resourceVersion = object.metadata?.resourceVersion ?? "";
	}
}

export function cacheMapFromList<T extends KubernetesObject>(newObjects: T[]): CacheMap<T> {
	const objects: CacheMap<T> = new Map();

	if (!newObjects) {
		return objects;
	}

	for (const obj of newObjects) {
		let namespaceObjects = objects.get(obj.metadata?.namespace ?? "");
		if (!namespaceObjects) {
			namespaceObjects = new Map();
			objects.set(obj.metadata?.namespace ?? "", namespaceObjects);
		}

		namespaceObjects.set(obj.metadata?.name ?? "", obj);
	}

	return objects;
}

export function deleteItems<T extends KubernetesObject>(
	oldObjects: CacheMap<T>,
	newObjects: T[],
	deleteCallbacks?: Array<ObjectCallback<T>>,
): CacheMap<T> {
	const newObjectMap = cacheMapFromList(newObjects);

	for (const [namespace, oldNamespaceObjects] of oldObjects.entries()) {
		const newNamespaceObjects = newObjectMap.get(namespace);
		if (newNamespaceObjects) {
			for (const [name, oldObject] of oldNamespaceObjects.entries()) {
				if (newNamespaceObjects.has(name)) {
					continue;
				}

				oldNamespaceObjects.delete(name);
				for (const callback of deleteCallbacks ?? []) {
					callback(oldObject);
				}
			}
			continue;
		}

		oldObjects.delete(namespace);
		for (const object of oldNamespaceObjects.values()) {
			for (const callback of deleteCallbacks ?? []) {
				callback(object);
			}
		}
	}

	return oldObjects;
}

export function addOrUpdateObject<T extends KubernetesObject>(
	objects: CacheMap<T>,
	obj: T,
	addCallbacks?: Array<ObjectCallback<T>>,
	updateCallbacks?: Array<ObjectCallback<T>>,
): boolean {
	let namespaceObjects = objects.get(obj.metadata?.namespace ?? "");
	if (!namespaceObjects) {
		namespaceObjects = new Map();
		objects.set(obj.metadata?.namespace ?? "", namespaceObjects);
	}

	const name = obj.metadata?.name ?? "";
	const existing = namespaceObjects.get(name);
	if (!existing) {
		namespaceObjects.set(name, obj);
		for (const callback of addCallbacks ?? []) {
			callback(obj);
		}
		return true;
	}

	if (sameResourceVersion(existing, obj)) {
		return false;
	}

	namespaceObjects.set(name, obj);
	for (const callback of updateCallbacks ?? []) {
		callback(obj);
	}
	return true;
}

export function deleteObject<T extends KubernetesObject>(
	objects: CacheMap<T>,
	obj: T,
	deleteCallbacks?: Array<ObjectCallback<T>>,
): void {
	const namespace = obj.metadata?.namespace ?? "";
	const name = obj.metadata?.name ?? "";
	const namespaceObjects = objects.get(namespace);
	if (!namespaceObjects) {
		return;
	}

	const deleted = namespaceObjects.delete(name);
	if (!deleted) {
		return;
	}

	for (const callback of deleteCallbacks ?? []) {
		callback(obj);
	}

	if (namespaceObjects.size === 0) {
		objects.delete(namespace);
	}
}

function sameResourceVersion<T extends KubernetesObject>(left: T, right: T): boolean {
	return (
		left.metadata?.resourceVersion !== undefined &&
		left.metadata?.resourceVersion !== null &&
		left.metadata.resourceVersion === right.metadata?.resourceVersion
	);
}

function isGoneError(error: unknown): error is HttpError {
	if (!(error instanceof Error)) {
		return false;
	}

	const statusCode = "statusCode" in error ? error.statusCode : undefined;
	const code = "code" in error ? error.code : undefined;
	return statusCode === 410 || code === 410;
}
