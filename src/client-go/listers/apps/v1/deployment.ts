/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { Selector } from "../../../../apimachinery/pkg/labels/selector";
import type { V1Deployment } from "../../../../client";
import type { Indexer } from "../../../tools/cache/index";
import {
	newNamespacedResourceIndexer,
	newResourceIndexer,
	type ResourceIndexer,
} from "../../generic-helpers";

// Models staging/src/k8s.io/client-go/listers/apps/v1/deployment.go DeploymentLister.
export interface DeploymentLister {
	list(selector: Selector): [ret: V1Deployment[], err: Error | undefined];
	deployments(namespace: string): DeploymentNamespaceLister;
}

// Models staging/src/k8s.io/client-go/listers/apps/v1/deployment.go deploymentLister.
class DeploymentListerImpl implements DeploymentLister {
	constructor(private readonly resourceIndexer: ResourceIndexer<V1Deployment>) {}

	list(selector: Selector): [ret: V1Deployment[], err: Error | undefined] {
		return this.resourceIndexer.list(selector);
	}

	deployments(namespace: string): DeploymentNamespaceLister {
		return new DeploymentNamespaceListerImpl(
			newNamespacedResourceIndexer(this.resourceIndexer, namespace),
		);
	}
}

// Models staging/src/k8s.io/client-go/listers/apps/v1/deployment.go NewDeploymentLister.
export function newDeploymentLister(indexer: Indexer<V1Deployment>): DeploymentLister {
	return new DeploymentListerImpl(newResourceIndexer(indexer, "deployment"));
}

// Models staging/src/k8s.io/client-go/listers/apps/v1/deployment.go DeploymentNamespaceLister.
export interface DeploymentNamespaceLister {
	list(selector: Selector): [ret: V1Deployment[], err: Error | undefined];
	get(name: string): [ret: V1Deployment | undefined, err: Error | undefined];
}

// Models staging/src/k8s.io/client-go/listers/apps/v1/deployment.go deploymentNamespaceLister.
class DeploymentNamespaceListerImpl implements DeploymentNamespaceLister {
	constructor(private readonly resourceIndexer: ResourceIndexer<V1Deployment>) {}

	list(selector: Selector): [ret: V1Deployment[], err: Error | undefined] {
		return this.resourceIndexer.list(selector);
	}

	get(name: string): [ret: V1Deployment | undefined, err: Error | undefined] {
		return this.resourceIndexer.get(name);
	}
}
