/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { Selector } from "../../../../apimachinery/pkg/labels/selector";
import type { V1Pod } from "../../../../client";
import type { Indexer } from "../../../tools/cache/index";
import {
	newNamespacedResourceIndexer,
	newResourceIndexer,
	type ResourceIndexer,
} from "../../generic-helpers";

// Models staging/src/k8s.io/client-go/listers/core/v1/pod.go PodLister.
export interface PodLister {
	list(selector: Selector): [ret: V1Pod[], err: Error | undefined];
	pods(namespace: string): PodNamespaceLister;
}

// Models staging/src/k8s.io/client-go/listers/core/v1/pod.go podLister.
class PodListerImpl implements PodLister {
	constructor(private readonly resourceIndexer: ResourceIndexer<V1Pod>) {}

	list(selector: Selector): [ret: V1Pod[], err: Error | undefined] {
		return this.resourceIndexer.list(selector);
	}

	pods(namespace: string): PodNamespaceLister {
		return new PodNamespaceListerImpl(
			newNamespacedResourceIndexer(this.resourceIndexer, namespace),
		);
	}
}

// Models staging/src/k8s.io/client-go/listers/core/v1/pod.go NewPodLister.
export function newPodLister(indexer: Indexer<V1Pod>): PodLister {
	return new PodListerImpl(newResourceIndexer(indexer, "pod"));
}

// Models staging/src/k8s.io/client-go/listers/core/v1/pod.go PodNamespaceLister.
export interface PodNamespaceLister {
	list(selector: Selector): [ret: V1Pod[], err: Error | undefined];
	get(name: string): [ret: V1Pod | undefined, err: Error | undefined];
}

// Models staging/src/k8s.io/client-go/listers/core/v1/pod.go podNamespaceLister.
class PodNamespaceListerImpl implements PodNamespaceLister {
	constructor(private readonly resourceIndexer: ResourceIndexer<V1Pod>) {}

	list(selector: Selector): [ret: V1Pod[], err: Error | undefined] {
		return this.resourceIndexer.list(selector);
	}

	get(name: string): [ret: V1Pod | undefined, err: Error | undefined] {
		return this.resourceIndexer.get(name);
	}
}
