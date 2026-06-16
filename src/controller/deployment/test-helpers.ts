/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type * as k8s from "../../client";

export const namespaceDefault = "default";
export const noTimestamp: Date | undefined = undefined;

// Models kubernetes/pkg/controller/deployment/deployment_controller_test.go rs.
export function rs(
	name: string,
	replicas: number,
	selector: Record<string, string> | undefined,
	timestamp: Date | undefined,
): k8s.V1ReplicaSet {
	const labels = selector ?? { name };
	return {
		apiVersion: "apps/v1",
		kind: "ReplicaSet",
		metadata: {
			name,
			creationTimestamp: timestamp,
			namespace: namespaceDefault,
		},
		spec: {
			replicas,
			selector: { matchLabels: labels },
			template: {
				metadata: {
					labels,
				},
			},
		},
	};
}

// Models kubernetes/pkg/controller/deployment/deployment_controller_test.go newDeployment.
export function newDeployment(
	name: string,
	replicas: number,
	revisionHistoryLimit: number | undefined,
	maxSurge: k8s.IntOrString | undefined,
	maxUnavailable: k8s.IntOrString | undefined,
	selector: Record<string, string> | undefined,
): k8s.V1Deployment {
	const deployment: k8s.V1Deployment = {
		apiVersion: "apps/v1",
		kind: "Deployment",
		metadata: {
			uid: `${name}-uid`,
			name,
			namespace: namespaceDefault,
			annotations: {},
		},
		spec: {
			strategy: {
				type: "RollingUpdate",
				rollingUpdate: {
					maxUnavailable: 0,
					maxSurge: 0,
				},
			},
			replicas,
			selector: { matchLabels: selector },
			template: {
				metadata: {
					labels: selector,
				},
				spec: {
					containers: [
						{
							name: "container",
							image: "foo/bar",
						},
					],
				},
			},
			revisionHistoryLimit,
		},
	};
	if (maxSurge !== undefined) {
		const rollingUpdate = deployment.spec?.strategy?.rollingUpdate;
		if (!rollingUpdate) {
			throw new Error("deployment rollingUpdate is nil");
		}
		rollingUpdate.maxSurge = maxSurge;
	}
	if (maxUnavailable !== undefined) {
		const rollingUpdate = deployment.spec?.strategy?.rollingUpdate;
		if (!rollingUpdate) {
			throw new Error("deployment rollingUpdate is nil");
		}
		rollingUpdate.maxUnavailable = maxUnavailable;
	}
	return deployment;
}

// Models kubernetes/pkg/controller/deployment/deployment_controller_test.go newReplicaSet.
export function newReplicaSet(
	deployment: k8s.V1Deployment,
	name: string,
	replicas: number,
): k8s.V1ReplicaSet {
	return {
		apiVersion: "apps/v1",
		kind: "ReplicaSet",
		metadata: {
			name,
			uid: `${name}-uid`,
			namespace: namespaceDefault,
			labels: deployment.spec?.selector?.matchLabels,
			ownerReferences: [
				{
					apiVersion: "apps/v1",
					kind: "Deployment",
					name: deployment.metadata?.name ?? "",
					uid: deployment.metadata?.uid ?? "",
					controller: true,
					blockOwnerDeletion: true,
				},
			],
		},
		spec: {
			selector: deployment.spec?.selector ?? { matchLabels: {} },
			replicas,
			template: deployment.spec?.template ?? {},
		},
	};
}
