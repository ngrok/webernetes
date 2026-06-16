/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { labelSelectorAsSelector } from "../../../../apimachinery/pkg/apis/meta/v1/helpers";
import { Set as LabelSet } from "../../../../apimachinery/pkg/labels/labels";
import { everything, type Selector } from "../../../../apimachinery/pkg/labels/selector";
import type { V1Pod, V1ReplicaSet } from "../../../../client";
import type { Indexer } from "../../../tools/cache/index";
import {
	newNamespacedResourceIndexer,
	newResourceIndexer,
	type ResourceIndexer,
} from "../../generic-helpers";

// Models staging/src/k8s.io/client-go/listers/apps/v1/replicaset.go ReplicaSetLister.
export interface ReplicaSetLister {
	list(selector: Selector): [ret: V1ReplicaSet[], err: Error | undefined];
	replicaSets(namespace: string): ReplicaSetNamespaceLister;
	getPodReplicaSets(pod: V1Pod): [ret: V1ReplicaSet[], err: Error | undefined];
}

// Models staging/src/k8s.io/client-go/listers/apps/v1/replicaset.go replicaSetLister.
class ReplicaSetListerImpl implements ReplicaSetLister {
	constructor(private readonly resourceIndexer: ResourceIndexer<V1ReplicaSet>) {}

	list(selector: Selector): [ret: V1ReplicaSet[], err: Error | undefined] {
		return this.resourceIndexer.list(selector);
	}

	replicaSets(namespace: string): ReplicaSetNamespaceLister {
		return new ReplicaSetNamespaceListerImpl(
			newNamespacedResourceIndexer(this.resourceIndexer, namespace),
		);
	}

	// Models staging/src/k8s.io/client-go/listers/apps/v1/replicaset_expansion.go GetPodReplicaSets.
	getPodReplicaSets(pod: V1Pod): [ret: V1ReplicaSet[], err: Error | undefined] {
		if (Object.keys(pod.metadata?.labels ?? {}).length === 0) {
			return [
				[],
				new Error(
					`no ReplicaSets found for pod ${pod.metadata?.name ?? ""} because it has no labels`,
				),
			];
		}

		const [list, err] = this.replicaSets(pod.metadata?.namespace ?? "default").list(everything());
		if (err) {
			return [[], err];
		}

		const rss: V1ReplicaSet[] = [];
		for (const rs of list) {
			if ((rs.metadata?.namespace ?? "default") !== (pod.metadata?.namespace ?? "default")) {
				continue;
			}
			const [selector, selectorErr] = labelSelectorAsSelector(rs.spec?.selector);
			if (selectorErr || !selector) {
				continue;
			}
			if (selector.empty() || !selector.matches(new LabelSet(pod.metadata?.labels))) {
				continue;
			}
			rss.push(rs);
		}

		if (rss.length === 0) {
			return [
				[],
				new Error(
					`could not find ReplicaSet for pod ${pod.metadata?.name ?? ""} in namespace ${
						pod.metadata?.namespace ?? "default"
					} with labels: ${JSON.stringify(pod.metadata?.labels ?? {})}`,
				),
			];
		}
		return [rss, undefined];
	}
}

// Models staging/src/k8s.io/client-go/listers/apps/v1/replicaset.go NewReplicaSetLister.
export function newReplicaSetLister(indexer: Indexer<V1ReplicaSet>): ReplicaSetLister {
	return new ReplicaSetListerImpl(newResourceIndexer(indexer, "replicaset"));
}

// Models staging/src/k8s.io/client-go/listers/apps/v1/replicaset.go ReplicaSetNamespaceLister.
export interface ReplicaSetNamespaceLister {
	list(selector: Selector): [ret: V1ReplicaSet[], err: Error | undefined];
	get(name: string): [ret: V1ReplicaSet | undefined, err: Error | undefined];
}

// Models staging/src/k8s.io/client-go/listers/apps/v1/replicaset.go replicaSetNamespaceLister.
class ReplicaSetNamespaceListerImpl implements ReplicaSetNamespaceLister {
	constructor(private readonly resourceIndexer: ResourceIndexer<V1ReplicaSet>) {}

	list(selector: Selector): [ret: V1ReplicaSet[], err: Error | undefined] {
		return this.resourceIndexer.list(selector);
	}

	get(name: string): [ret: V1ReplicaSet | undefined, err: Error | undefined] {
		return this.resourceIndexer.get(name);
	}
}
