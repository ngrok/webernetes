/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { Set as LabelSet } from "../../apimachinery/pkg/labels/labels";
import type { Selector } from "../../apimachinery/pkg/labels/selector";
import type { KubernetesObject } from "../../client/types";
import type { Indexer } from "../tools/cache/index";

// Models staging/src/k8s.io/client-go/listers/generic_helpers.go ResourceIndexer.
export class ResourceIndexer<T extends KubernetesObject> {
	constructor(
		readonly indexer: Indexer<T>,
		readonly resource: string,
		readonly namespace = "",
	) {}

	// Models staging/src/k8s.io/client-go/listers/generic_helpers.go ResourceIndexer.List.
	list(selector: Selector): [ret: T[], err: Error | undefined] {
		const ret: T[] = [];
		for (const obj of this.indexer.list()) {
			if (this.namespace && objectNamespace(obj) !== this.namespace) {
				continue;
			}
			if (!selector.matches(new LabelSet(obj.metadata?.labels))) {
				continue;
			}
			ret.push(obj);
		}
		return [ret, undefined];
	}

	// Models staging/src/k8s.io/client-go/listers/generic_helpers.go ResourceIndexer.Get.
	get(name: string): [obj: T | undefined, err: Error | undefined] {
		const key = this.namespace ? `${this.namespace}/${name}` : name;
		const [obj, exists, err] = this.indexer.getByKey(key);
		if (err) {
			return [undefined, err];
		}
		if (!exists) {
			return [undefined, new Error(`${this.resource} ${name} not found`)];
		}
		return [obj, undefined];
	}
}

function objectNamespace(obj: KubernetesObject): string {
	return obj.metadata?.namespace ?? "default";
}

// Models staging/src/k8s.io/client-go/listers/generic_helpers.go New.
export function newResourceIndexer<T extends KubernetesObject>(
	indexer: Indexer<T>,
	resource: string,
): ResourceIndexer<T> {
	return new ResourceIndexer(indexer, resource);
}

// Models staging/src/k8s.io/client-go/listers/generic_helpers.go NewNamespaced.
export function newNamespacedResourceIndexer<T extends KubernetesObject>(
	parent: ResourceIndexer<T>,
	namespace: string,
): ResourceIndexer<T> {
	return new ResourceIndexer(parent.indexer, parent.resource, namespace);
}
