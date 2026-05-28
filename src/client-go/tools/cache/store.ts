import type { KubernetesObject } from "../../../client/types";
import type { MaybePromise } from "../../../promise";

// Models staging/src/k8s.io/client-go/tools/cache/store.go KeyFunc.
export type KeyFunc<T extends KubernetesObject> = (
	obj: T | ExplicitKey,
) => MaybePromise<[key: string, err: Error | undefined]>;

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

// Models staging/src/k8s.io/client-go/tools/cache/store.go ExplicitKey.
export class ExplicitKey {
	constructor(readonly key: string) {}
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
