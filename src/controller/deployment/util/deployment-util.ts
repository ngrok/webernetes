/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import * as k8s from "../../../client";
import { defaultDeploymentUniqueLabelKey } from "../../../apis/apps/v1/types";
import { getClock } from "../../../clock-context";
import { deepEqual } from "../../../deep-equal";
import { getScaledValueFromIntOrPercent } from "../../../apimachinery/pkg/util/intstr/intstr";
import { parseInt } from "../../../go/strconv";
import type * as context from "../../../go/context";
import {
	compareReplicaSetsByCreationTimestamp,
	filterActiveReplicaSets,
} from "../../controller-utils";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go RevisionAnnotation.
export const revisionAnnotation = "deployment.kubernetes.io/revision";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go DesiredReplicasAnnotation.
export const desiredReplicasAnnotation = "deployment.kubernetes.io/desired-replicas";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go MaxReplicasAnnotation.
export const maxReplicasAnnotation = "deployment.kubernetes.io/max-replicas";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go RevisionHistoryAnnotation.
export const revisionHistoryAnnotation = "deployment.kubernetes.io/revision-history";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go ReplicaSetUpdatedReason.
export const replicaSetUpdatedReason = "ReplicaSetUpdated";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go FailedRSCreateReason.
export const failedRSCreateReason = "ReplicaSetCreateError";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go NewReplicaSetReason.
export const newReplicaSetReason = "NewReplicaSetCreated";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go FoundNewRSReason.
export const foundNewRSReason = "FoundNewReplicaSet";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go NewRSAvailableReason.
export const newRSAvailableReason = "NewReplicaSetAvailable";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go TimedOutReason.
export const timedOutReason = "ProgressDeadlineExceeded";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go PausedDeployReason.
export const pausedDeployReason = "DeploymentPaused";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go ResumedDeployReason.
export const resumedDeployReason = "DeploymentResumed";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go MinimumReplicasAvailable.
export const minimumReplicasAvailable = "MinimumReplicasAvailable";

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go MinimumReplicasUnavailable.
export const minimumReplicasUnavailable = "MinimumReplicasUnavailable";

const lastAppliedConfigAnnotation = "kubectl.kubernetes.io/last-applied-configuration";
const deprecatedRollbackTo = "deprecated.deployment.rollback.to";
const maxInt32 = 2147483647;

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go NewDeploymentCondition.
export function newDeploymentCondition(
	now: Date,
	type: string,
	status: string,
	reason: string,
	message: string,
): k8s.V1DeploymentCondition {
	return {
		type,
		status,
		lastUpdateTime: now,
		lastTransitionTime: now,
		reason,
		message,
	};
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go GetDeploymentCondition.
export function getDeploymentCondition(
	status: k8s.V1DeploymentStatus | undefined,
	condType: string,
): k8s.V1DeploymentCondition | undefined {
	for (const condition of status?.conditions ?? []) {
		if (condition.type === condType) {
			return condition;
		}
	}
	return undefined;
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go SetDeploymentCondition.
export function setDeploymentCondition(
	status: k8s.V1DeploymentStatus,
	condition: k8s.V1DeploymentCondition,
): void {
	const currentCond = getDeploymentCondition(status, condition.type);
	if (
		currentCond &&
		currentCond.status === condition.status &&
		currentCond.reason === condition.reason
	) {
		return;
	}
	if (currentCond && currentCond.status === condition.status) {
		condition.lastTransitionTime = currentCond.lastTransitionTime;
	}
	status.conditions = filterOutCondition(status.conditions ?? [], condition.type);
	status.conditions.push(condition);
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go RemoveDeploymentCondition.
export function removeDeploymentCondition(status: k8s.V1DeploymentStatus, condType: string): void {
	status.conditions = filterOutCondition(status.conditions ?? [], condType);
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go filterOutCondition.
function filterOutCondition(
	conditions: k8s.V1DeploymentCondition[],
	condType: string,
): k8s.V1DeploymentCondition[] {
	return conditions.filter((condition) => condition.type !== condType);
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go ReplicaSetToDeploymentCondition.
export function replicaSetToDeploymentCondition(
	condition: k8s.V1ReplicaSetCondition,
): k8s.V1DeploymentCondition {
	return {
		type: condition.type,
		status: condition.status,
		lastTransitionTime: condition.lastTransitionTime,
		lastUpdateTime: condition.lastTransitionTime,
		reason: condition.reason,
		message: condition.message,
	};
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go SetDeploymentRevision.
export function setDeploymentRevision(deployment: k8s.V1Deployment, revision: string): boolean {
	let updated = false;
	deployment.metadata ??= {};
	deployment.metadata.annotations ??= {};
	if (deployment.metadata.annotations[revisionAnnotation] !== revision) {
		deployment.metadata.annotations[revisionAnnotation] = revision;
		updated = true;
	}
	return updated;
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go MaxRevision.
export function maxRevision(allRSs: k8s.V1ReplicaSet[]): number {
	let max = 0;
	for (const rs of allRSs) {
		const [value, err] = revision(rs);
		if (!err && value > max) {
			max = value;
		}
	}
	return max;
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go SetNewReplicaSetAnnotations.
export function setNewReplicaSetAnnotations(
	deployment: k8s.V1Deployment,
	newRS: k8s.V1ReplicaSet,
	newRevision: string,
	exists: boolean,
	revHistoryLimitInChars: number,
): boolean {
	let annotationChanged = copyDeploymentAnnotationsToReplicaSet(deployment, newRS);
	newRS.metadata ??= {};
	newRS.metadata.annotations ??= {};

	const oldRevision = newRS.metadata.annotations[revisionAnnotation] ?? "";
	const hadOldRevision = oldRevision !== "";
	let [oldRevisionInt, oldRevisionErr] = parseInt(oldRevision, 10, 64);
	if (oldRevisionErr) {
		if (oldRevision !== "") {
			return false;
		}
		oldRevisionInt = BigInt(0);
	}
	const [newRevisionInt, newRevisionErr] = parseInt(newRevision, 10, 64);
	if (newRevisionErr) {
		return false;
	}
	if (oldRevisionInt < newRevisionInt) {
		newRS.metadata.annotations[revisionAnnotation] = newRevision;
		annotationChanged = true;
	}
	if (hadOldRevision && oldRevisionInt < newRevisionInt) {
		const revisionHistoryAnnotationValue =
			newRS.metadata.annotations[revisionHistoryAnnotation] ?? "";
		let oldRevisions = revisionHistoryAnnotationValue.split(",");
		if (oldRevisions[0].length === 0) {
			newRS.metadata.annotations[revisionHistoryAnnotation] = oldRevision;
		} else {
			let totalLen = revisionHistoryAnnotationValue.length + oldRevision.length + 1;
			let start = 0;
			while (totalLen > revHistoryLimitInChars && start < oldRevisions.length) {
				totalLen = totalLen - oldRevisions[start].length - 1;
				start++;
			}
			if (totalLen <= revHistoryLimitInChars) {
				oldRevisions = [...oldRevisions.slice(start), oldRevision];
				newRS.metadata.annotations[revisionHistoryAnnotation] = oldRevisions.join(",");
			}
		}
	}
	if (
		!exists &&
		setReplicasAnnotations(
			newRS,
			deployment.spec?.replicas ?? 1,
			(deployment.spec?.replicas ?? 1) + maxSurge(deployment),
		)
	) {
		annotationChanged = true;
	}
	return annotationChanged;
}

function copyDeploymentAnnotationsToReplicaSet(
	deployment: k8s.V1Deployment,
	rs: k8s.V1ReplicaSet,
): boolean {
	let rsAnnotationsChanged = false;
	rs.metadata ??= {};
	rs.metadata.annotations ??= {};
	for (const [key, value] of Object.entries(deployment.metadata?.annotations ?? {})) {
		if (
			skipCopyAnnotation(key) ||
			(rs.metadata.annotations[key] !== undefined && rs.metadata.annotations[key] === value)
		) {
			continue;
		}
		rs.metadata.annotations[key] = value;
		rsAnnotationsChanged = true;
	}
	return rsAnnotationsChanged;
}

function skipCopyAnnotation(key: string): boolean {
	return (
		key === lastAppliedConfigAnnotation ||
		key === revisionAnnotation ||
		key === revisionHistoryAnnotation ||
		key === desiredReplicasAnnotation ||
		key === maxReplicasAnnotation ||
		key === deprecatedRollbackTo
	);
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go FindActiveOrLatest.
export function findActiveOrLatest(
	newRS: k8s.V1ReplicaSet | undefined,
	oldRSs: k8s.V1ReplicaSet[],
): k8s.V1ReplicaSet | undefined {
	if (!newRS && oldRSs.length === 0) {
		return undefined;
	}
	const sortedOldRSs = [...oldRSs].sort(compareReplicaSetsByCreationTimestamp).reverse();
	const allRSs = filterActiveReplicaSets(
		[...sortedOldRSs, newRS].filter((rs): rs is k8s.V1ReplicaSet => rs !== undefined),
	);
	switch (allRSs.length) {
		case 0:
			return newRS ?? sortedOldRSs[0];
		case 1:
			return allRSs[0];
		default:
			return undefined;
	}
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go GetDesiredReplicasAnnotation.
export function getDesiredReplicasAnnotation(replicaSet: k8s.V1ReplicaSet): [number, boolean] {
	return getNonNegativeInt32FromAnnotation(replicaSet, desiredReplicasAnnotation);
}

function getMaxReplicasAnnotation(replicaSet: k8s.V1ReplicaSet): [number, boolean] {
	return getNonNegativeInt32FromAnnotation(replicaSet, maxReplicasAnnotation);
}

function getNonNegativeInt32FromAnnotation(
	replicaSet: k8s.V1ReplicaSet,
	annotationKey: string,
): [number, boolean] {
	const annotationValue = replicaSet.metadata?.annotations?.[annotationKey];
	if (annotationValue === undefined) {
		return [0, false];
	}
	const parsed = Number.parseInt(annotationValue, 10);
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > maxInt32) {
		return [0, false];
	}
	return [parsed, true];
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go ReplicasAnnotationsNeedUpdate.
export function replicasAnnotationsNeedUpdate(
	rs: k8s.V1ReplicaSet,
	desiredReplicas: number,
	maxReplicas: number,
): boolean {
	if (!rs.metadata?.annotations) {
		return true;
	}
	return (
		rs.metadata.annotations[desiredReplicasAnnotation] !== String(desiredReplicas) ||
		rs.metadata.annotations[maxReplicasAnnotation] !== String(maxReplicas)
	);
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go GetReplicaSetProportion.
export function getReplicaSetProportion(
	rs: k8s.V1ReplicaSet,
	deployment: k8s.V1Deployment,
	deploymentReplicasToAdd: number,
	deploymentReplicasAdded: number,
): number {
	if (
		(rs.spec?.replicas ?? 0) === 0 ||
		deploymentReplicasToAdd === 0 ||
		deploymentReplicasToAdd === deploymentReplicasAdded
	) {
		return 0;
	}
	const rsFraction = getReplicaSetFraction(rs, deployment);
	const allowed = deploymentReplicasToAdd - deploymentReplicasAdded;
	if (deploymentReplicasToAdd > 0) {
		return Math.min(rsFraction, allowed);
	}
	return Math.max(rsFraction, allowed);
}

function getReplicaSetFraction(rs: k8s.V1ReplicaSet, deployment: k8s.V1Deployment): number {
	const deploymentReplicas = deployment.spec?.replicas ?? 1;
	if (deploymentReplicas === 0) {
		return -(rs.spec?.replicas ?? 0);
	}
	const deploymentMaxReplicas = deploymentReplicas + maxSurge(deployment);
	let [deploymentMaxReplicasBeforeScale, ok] = getMaxReplicasAnnotation(rs);
	if (!ok || deploymentMaxReplicasBeforeScale === 0) {
		deploymentMaxReplicasBeforeScale = deployment.status?.replicas ?? 0;
		if (deploymentMaxReplicasBeforeScale === 0) {
			return 0;
		}
	}
	const scaleBase = rs.spec?.replicas ?? 0;
	const newRSSize = (scaleBase * deploymentMaxReplicas) / deploymentMaxReplicasBeforeScale;
	return Math.round(newRSSize) - scaleBase;
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go IsSaturated.
export function isSaturated(
	deployment: k8s.V1Deployment,
	rs: k8s.V1ReplicaSet | undefined,
): boolean {
	if (!rs) {
		return false;
	}
	const desiredString = rs.metadata?.annotations?.[desiredReplicasAnnotation];
	const desired = desiredString === undefined ? Number.NaN : Number.parseInt(desiredString, 10);
	if (Number.isNaN(desired)) {
		return false;
	}
	const deploymentReplicas = deployment.spec?.replicas ?? 1;
	return (
		(rs.spec?.replicas ?? 0) === deploymentReplicas &&
		desired === deploymentReplicas &&
		(rs.status?.availableReplicas ?? 0) === deploymentReplicas
	);
}

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

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go DeploymentProgressing.
export function deploymentProgressing(
	deployment: k8s.V1Deployment,
	newStatus: k8s.V1DeploymentStatus,
): boolean {
	const oldStatus = deployment.status ?? {};
	const oldStatusOldReplicas = (oldStatus.replicas ?? 0) - (oldStatus.updatedReplicas ?? 0);
	const newStatusOldReplicas = (newStatus.replicas ?? 0) - (newStatus.updatedReplicas ?? 0);
	return (
		(newStatus.updatedReplicas ?? 0) > (oldStatus.updatedReplicas ?? 0) ||
		newStatusOldReplicas < oldStatusOldReplicas ||
		(newStatus.readyReplicas ?? 0) > (oldStatus.readyReplicas ?? 0) ||
		(newStatus.availableReplicas ?? 0) > (oldStatus.availableReplicas ?? 0)
	);
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go DeploymentTimedOut.
export function deploymentTimedOut(
	ctx: context.Context,
	deployment: k8s.V1Deployment,
	newStatus: k8s.V1DeploymentStatus,
): boolean {
	if (!hasProgressDeadline(deployment)) {
		return false;
	}
	const condition = getDeploymentCondition(newStatus, "Progressing");
	if (!condition) {
		return false;
	}
	if (condition.reason === newRSAvailableReason) {
		return false;
	}
	if (condition.reason === timedOutReason) {
		return true;
	}
	const from = condition.lastUpdateTime;
	if (!from) {
		return false;
	}
	const now = getClock(ctx).now();
	const deltaMs = (deployment.spec?.progressDeadlineSeconds ?? 0) * 1000;
	return from.getTime() + deltaMs < now.getTime();
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
		deployment.spec.revisionHistoryLimit !== maxInt32
	);
}

// Models kubernetes/pkg/controller/deployment/util/deployment_util.go HasProgressDeadline.
export function hasProgressDeadline(deployment: k8s.V1Deployment): boolean {
	return (
		deployment.spec?.progressDeadlineSeconds !== undefined &&
		deployment.spec.progressDeadlineSeconds !== maxInt32
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
