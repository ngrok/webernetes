/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import * as k8s from "../../../client";
import { defaultDeploymentUniqueLabelKey } from "../../../apis/apps/v1/types";
import { deepEqual } from "../../../deep-equal";
import { getScaledValueFromIntOrPercent } from "../../../apimachinery/pkg/util/intstr/intstr";
import { parseInt } from "../../../go/strconv";
import { compareReplicaSetsByCreationTimestamp } from "../../controller-utils";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go RevisionAnnotation.
export const revisionAnnotation = "deployment.kubernetes.io/revision";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go DesiredReplicasAnnotation.
export const desiredReplicasAnnotation = "deployment.kubernetes.io/desired-replicas";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go MaxReplicasAnnotation.
export const maxReplicasAnnotation = "deployment.kubernetes.io/max-replicas";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go SetReplicasAnnotations.
export function setReplicasAnnotations(
	replicaSet: k8s.V1ReplicaSet,
	desiredReplicas: number,
	maxReplicas: number,
): boolean {
	let updated = false;
	replicaSet.metadata ??= {};
	replicaSet.metadata.annotations ??= {};
	const desiredString = String(desiredReplicas);
	if (replicaSet.metadata.annotations[desiredReplicasAnnotation] !== desiredString) {
		replicaSet.metadata.annotations[desiredReplicasAnnotation] = desiredString;
		updated = true;
	}
	const maxString = String(maxReplicas);
	if (replicaSet.metadata.annotations[maxReplicasAnnotation] !== maxString) {
		replicaSet.metadata.annotations[maxReplicasAnnotation] = maxString;
		updated = true;
	}
	return updated;
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go MaxUnavailable.
export function maxUnavailable(deployment: k8s.V1Deployment): number {
	const desired = deployment.spec?.replicas ?? 1;
	if (!isRollingUpdate(deployment) || desired === 0) {
		return 0;
	}
	const [, unavailable] = resolveFenceposts(
		deployment.spec?.strategy?.rollingUpdate?.maxSurge,
		deployment.spec?.strategy?.rollingUpdate?.maxUnavailable,
		desired,
	);
	if (unavailable > desired) {
		return desired;
	}
	return unavailable;
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go MinAvailable.
export function minAvailable(deployment: k8s.V1Deployment): number {
	if (!isRollingUpdate(deployment)) {
		return 0;
	}
	return (deployment.spec?.replicas ?? 1) - maxUnavailable(deployment);
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go MaxSurge.
export function maxSurge(deployment: k8s.V1Deployment): number {
	if (!isRollingUpdate(deployment)) {
		return 0;
	}
	const [surge] = resolveFenceposts(
		deployment.spec?.strategy?.rollingUpdate?.maxSurge,
		deployment.spec?.strategy?.rollingUpdate?.maxUnavailable,
		deployment.spec?.replicas ?? 1,
	);
	return surge;
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go IsRollingUpdate.
export function isRollingUpdate(deployment: k8s.V1Deployment): boolean {
	return deployment.spec?.strategy?.type === "RollingUpdate";
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go EqualIgnoreHash.
export function equalIgnoreHash(
	template1: k8s.V1PodTemplateSpec | undefined,
	template2: k8s.V1PodTemplateSpec | undefined,
): boolean {
	const template1Copy = templateWithoutHash(template1 ?? {});
	const template2Copy = templateWithoutHash(template2 ?? {});
	return deepEqual(template1Copy, template2Copy);
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go FindNewReplicaSet.
export function findNewReplicaSet(
	deployment: k8s.V1Deployment,
	replicaSets: k8s.V1ReplicaSet[],
): k8s.V1ReplicaSet | undefined {
	const sorted = [...replicaSets].sort(compareReplicaSetsByCreationTimestamp);
	for (const replicaSet of sorted) {
		if (equalIgnoreHash(replicaSet.spec?.template, deployment.spec?.template)) {
			return replicaSet;
		}
	}
	return undefined;
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go FindOldReplicaSets.
export function findOldReplicaSets(
	deployment: k8s.V1Deployment,
	rsList: k8s.V1ReplicaSet[],
): [requiredReplicaSets: k8s.V1ReplicaSet[], allReplicaSets: k8s.V1ReplicaSet[]] {
	const requiredRSs: k8s.V1ReplicaSet[] = [];
	const allRSs: k8s.V1ReplicaSet[] = [];
	const newRS = findNewReplicaSet(deployment, rsList);
	for (const rs of rsList) {
		if (newRS && rs.metadata?.uid === newRS.metadata?.uid) {
			continue;
		}
		allRSs.push(rs);
		if ((rs.spec?.replicas ?? 0) !== 0) {
			requiredRSs.push(rs);
		}
	}
	return [requiredRSs, allRSs];
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go GetReplicaCountForReplicaSets.
export function getReplicaCountForReplicaSets(replicaSets: k8s.V1ReplicaSet[]): number {
	let totalReplicas = 0;
	for (const replicaSet of replicaSets) {
		totalReplicas += replicaSet.spec?.replicas ?? 0;
	}
	return totalReplicas;
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go GetActualReplicaCountForReplicaSets.
export function getActualReplicaCountForReplicaSets(replicaSets: k8s.V1ReplicaSet[]): number {
	let totalActualReplicas = 0;
	for (const replicaSet of replicaSets) {
		totalActualReplicas += replicaSet.status?.replicas ?? 0;
	}
	return totalActualReplicas;
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go GetTerminatingReplicaCountForReplicaSets.
export function getTerminatingReplicaCountForReplicaSets(
	replicaSets: k8s.V1ReplicaSet[],
): number | undefined {
	let terminatingReplicas = 0;
	for (const rs of replicaSets) {
		if (
			(rs.status?.observedGeneration ?? 0) === 0 &&
			rs.status?.terminatingReplicas === undefined
		) {
			continue;
		}
		if (rs.status?.terminatingReplicas === undefined) {
			return undefined;
		}
		terminatingReplicas += rs.status.terminatingReplicas;
	}
	return terminatingReplicas;
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go GetReadyReplicaCountForReplicaSets.
export function getReadyReplicaCountForReplicaSets(replicaSets: k8s.V1ReplicaSet[]): number {
	let totalReadyReplicas = 0;
	for (const rs of replicaSets) {
		totalReadyReplicas += rs.status?.readyReplicas ?? 0;
	}
	return totalReadyReplicas;
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go GetAvailableReplicaCountForReplicaSets.
export function getAvailableReplicaCountForReplicaSets(replicaSets: k8s.V1ReplicaSet[]): number {
	let totalAvailableReplicas = 0;
	for (const rs of replicaSets) {
		totalAvailableReplicas += rs.status?.availableReplicas ?? 0;
	}
	return totalAvailableReplicas;
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go DeploymentComplete.
export function deploymentComplete(
	deployment: k8s.V1Deployment,
	newStatus: k8s.V1DeploymentStatus,
): boolean {
	return (
		(newStatus.updatedReplicas ?? 0) === (deployment.spec?.replicas ?? 1) &&
		(newStatus.replicas ?? 0) === (deployment.spec?.replicas ?? 1) &&
		(newStatus.availableReplicas ?? 0) === (deployment.spec?.replicas ?? 1) &&
		(newStatus.observedGeneration ?? 0) >= (deployment.metadata?.generation ?? 0)
	);
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go NewRSNewReplicas.
export function newRSNewReplicas(
	deployment: k8s.V1Deployment,
	allRSs: k8s.V1ReplicaSet[],
	newRS: k8s.V1ReplicaSet,
): [replicas: number, err: Error | undefined] {
	switch (deployment.spec?.strategy?.type) {
		case "RollingUpdate": {
			const [maxSurge, err] = getScaledValueFromIntOrPercent(
				deployment.spec.strategy.rollingUpdate?.maxSurge ?? 0,
				deployment.spec.replicas ?? 1,
				true,
			);
			if (err) {
				return [0, err];
			}
			const currentPodCount = getReplicaCountForReplicaSets(allRSs);
			const maxTotalPods = (deployment.spec.replicas ?? 1) + maxSurge;
			if (currentPodCount >= maxTotalPods) {
				return [newRS.spec?.replicas ?? 0, undefined];
			}
			let scaleUpCount = maxTotalPods - currentPodCount;
			scaleUpCount = Math.min(
				scaleUpCount,
				(deployment.spec.replicas ?? 1) - (newRS.spec?.replicas ?? 0),
			);
			return [(newRS.spec?.replicas ?? 0) + scaleUpCount, undefined];
		}
		case "Recreate":
			return [deployment.spec?.replicas ?? 1, undefined];
		default:
			return [0, new Error(`deployment type ${deployment.spec?.strategy?.type} isn't supported`)];
	}
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go ResolveFenceposts.
export function resolveFenceposts(
	maxSurgeValue: k8s.IntOrString | undefined,
	maxUnavailableValue: k8s.IntOrString | undefined,
	desired: number,
): [maxSurge: number, maxUnavailable: number, err: Error | undefined] {
	const [surge, surgeErr] = getScaledValueFromIntOrPercent(maxSurgeValue ?? 0, desired, true);
	if (surgeErr) {
		return [0, 0, surgeErr];
	}
	let [unavailable, unavailableErr] = getScaledValueFromIntOrPercent(
		maxUnavailableValue ?? 0,
		desired,
		false,
	);
	if (unavailableErr) {
		return [0, 0, unavailableErr];
	}
	if (surge === 0 && unavailable === 0) {
		unavailable = 1;
	}
	return [surge, unavailable, undefined];
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go HasRevisionHistoryLimit.
export function hasRevisionHistoryLimit(deployment: k8s.V1Deployment): boolean {
	return (
		deployment.spec?.revisionHistoryLimit !== undefined &&
		deployment.spec.revisionHistoryLimit !== 2147483647
	);
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go Revision.
export function revision(replicaSet: k8s.V1ReplicaSet): [value: number, err: Error | undefined] {
	const value = replicaSet.metadata?.annotations?.[revisionAnnotation];
	if (value === undefined) {
		return [0, undefined];
	}
	const [parsed, err] = parseInt(value, 10, 64);
	if (err) {
		return [0, err];
	}
	return [Number(parsed), undefined];
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go ReplicaSetsByRevision.
export function compareReplicaSetsByRevision(
	left: k8s.V1ReplicaSet,
	right: k8s.V1ReplicaSet,
): number {
	const [leftRevision, leftErr] = revision(left);
	const [rightRevision, rightErr] = revision(right);
	if (leftErr || rightErr || leftRevision === rightRevision) {
		return compareReplicaSetsByCreationTimestamp(left, right);
	}
	return leftRevision - rightRevision;
}

function templateWithoutHash(template: k8s.V1PodTemplateSpec): k8s.V1PodTemplateSpec {
	const copy = structuredClone(template);
	if (copy.metadata?.labels) {
		delete copy.metadata.labels[defaultDeploymentUniqueLabelKey];
	}
	return copy;
}
