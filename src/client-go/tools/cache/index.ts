/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { KubernetesObject } from "../../../client/types";
import { ExplicitKey, type KeyFunc, type Store } from "./store";

// Models staging/src/k8s.io/client-go/tools/cache/index.go Indexer.
export interface Indexer<T> extends Store<T> {
	index(indexName: string, obj: T): [items: T[], err: Error | undefined];
	indexKeys(indexName: string, indexedValue: string): [keys: string[], err: Error | undefined];
	listIndexFuncValues(indexName: string): string[];
	byIndex(indexName: string, indexedValue: string): [items: T[], err: Error | undefined];
	getIndexers(): Indexers<T>;
	addIndexers(newIndexers: Indexers<T>): Error | undefined;
}

// Models staging/src/k8s.io/client-go/tools/cache/index.go IndexFunc.
export type IndexFunc<T> = (obj: T) => [values: string[], err: Error | undefined];

// Models staging/src/k8s.io/client-go/tools/cache/index.go IndexFuncToKeyFuncAdapter.
export function indexFuncToKeyFuncAdapter<T>(indexFunc: IndexFunc<T>): KeyFunc<T> {
	return (obj) => {
		if (obj instanceof ExplicitKey) {
			return [obj.key, undefined];
		}
		const [indexKeys, err] = indexFunc(obj);
		if (err) {
			return ["", err];
		}
		if (indexKeys.length > 1) {
			return ["", new Error(`too many keys: ${indexKeys.join(",")}`)];
		}
		if (indexKeys.length === 0) {
			return ["", new Error("unexpected empty indexKeys")];
		}
		return [indexKeys[0] ?? "", undefined];
	};
}

// Models staging/src/k8s.io/client-go/tools/cache/index.go NamespaceIndex.
export const namespaceIndex = "namespace";

// Models staging/src/k8s.io/client-go/tools/cache/index.go MetaNamespaceIndexFunc.
export function metaNamespaceIndexFunc<T extends KubernetesObject>(
	obj: T,
): [values: string[], err: Error | undefined] {
	if (!obj.metadata) {
		return [[""], new Error("object has no meta")];
	}
	return [[obj.metadata.namespace ?? ""], undefined];
}

// Models staging/src/k8s.io/client-go/tools/cache/index.go Index.
export type Index = Map<string, Set<string>>;

// Models staging/src/k8s.io/client-go/tools/cache/index.go Indexers.
export type Indexers<T> = Record<string, IndexFunc<T>>;

// Models staging/src/k8s.io/client-go/tools/cache/index.go Indices.
export type Indices = Map<string, Index>;
