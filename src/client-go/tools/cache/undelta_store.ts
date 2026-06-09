/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { KubernetesObject } from "../../../client/types";
import type { MaybePromise } from "../../../promise";
import type { ExplicitKey, KeyFunc, Store } from "./store";
import { newStore } from "./store";

// Models staging/src/k8s.io/client-go/tools/cache/undelta_store.go UndeltaStore.
export class UndeltaStore<T extends KubernetesObject> implements Store<T> {
	constructor(
		readonly store: Store<T>,
		readonly pushFunc: (list: T[]) => MaybePromise<void>,
	) {}

	// Models staging/src/k8s.io/client-go/tools/cache/undelta_store.go UndeltaStore.Add.
	async add(obj: T): Promise<Error | undefined> {
		const err = await this.store.add(obj);
		if (err) {
			return err;
		}
		await this.pushFunc(this.store.list());
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/undelta_store.go UndeltaStore.Update.
	async update(obj: T): Promise<Error | undefined> {
		const err = await this.store.update(obj);
		if (err) {
			return err;
		}
		await this.pushFunc(this.store.list());
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/undelta_store.go UndeltaStore.Delete.
	async delete(obj: T): Promise<Error | undefined> {
		const err = await this.store.delete(obj);
		if (err) {
			return err;
		}
		await this.pushFunc(this.store.list());
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go Store.List.
	list(): T[] {
		return this.store.list();
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go Store.ListKeys.
	listKeys(): string[] {
		return this.store.listKeys();
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go Store.LastStoreSyncResourceVersion.
	lastStoreSyncResourceVersion(): string {
		return this.store.lastStoreSyncResourceVersion();
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go Store.Bookmark.
	bookmark(resourceVersion: string): void {
		this.store.bookmark(resourceVersion);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go Store.Get.
	get(
		obj: T | ExplicitKey,
	): MaybePromise<[item: T | undefined, exists: boolean, err: Error | undefined]> {
		return this.store.get(obj);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go Store.GetByKey.
	getByKey(key: string): [item: T | undefined, exists: boolean, err: Error | undefined] {
		return this.store.getByKey(key);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/undelta_store.go UndeltaStore.Replace.
	async replace(list: T[], resourceVersion: string): Promise<Error | undefined> {
		const err = await this.store.replace(list, resourceVersion);
		if (err) {
			return err;
		}
		await this.pushFunc(this.store.list());
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go Store.Resync.
	resync(): MaybePromise<Error | undefined> {
		return this.store.resync();
	}
}

// Models staging/src/k8s.io/client-go/tools/cache/undelta_store.go NewUndeltaStore.
export function newUndeltaStore<T extends KubernetesObject>(
	pushFunc: (list: T[]) => MaybePromise<void>,
	keyFunc: KeyFunc<T>,
): UndeltaStore<T> {
	return new UndeltaStore(newStore(keyFunc), pushFunc);
}
