/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import * as k8s from "../../client";
import { Set as LabelSet } from "../../apimachinery/pkg/labels/labels";
import * as podutil from "../../cluster/api/v1/pod/util";
import { deepEqual } from "../../deep-equal";
import type { ReplicaSetControllerFeatures } from "./replica-set";

const statusUpdateRetries = 1;

// Models kubernetes/pkg/controller/replicaset/replica_set_utils.go updateReplicaSetStatus.
export async function updateReplicaSetStatus(
	api: k8s.KubeClient["appsv1"],
	namespace: string,
	name: string,
	rs: k8s.V1ReplicaSet,
	newStatus: k8s.V1ReplicaSetStatus,
	_controllerFeatures: ReplicaSetControllerFeatures,
): Promise<[k8s.V1ReplicaSet | undefined, Error | undefined]> {
	if (
		(rs.status?.replicas ?? 0) === newStatus.replicas &&
		(rs.status?.fullyLabeledReplicas ?? 0) === newStatus.fullyLabeledReplicas &&
		(rs.status?.readyReplicas ?? 0) === newStatus.readyReplicas &&
		(rs.status?.availableReplicas ?? 0) === newStatus.availableReplicas &&
		ptrEqual(rs.status?.terminatingReplicas, newStatus.terminatingReplicas) &&
		rs.metadata?.generation === rs.status?.observedGeneration &&
		deepEqual(rs.status?.conditions ?? [], newStatus.conditions ?? [], { ignoreUndefined: true })
	) {
		return [rs, undefined];
	}

	newStatus.observedGeneration = rs.metadata?.generation;

	let getErr: Error | undefined;
	let updateErr: Error | undefined;
	let updatedRS: k8s.V1ReplicaSet | undefined;
	for (let i = 0, current = rs; ; i++) {
		try {
			current.status = newStatus;
			updatedRS = await api.replaceNamespacedReplicaSetStatus({
				name,
				namespace,
				body: current,
			});
			return [updatedRS, undefined];
		} catch (error) {
			updateErr = toError(error);
		}
		if (i >= statusUpdateRetries) {
			break;
		}
		try {
			current = await api.readNamespacedReplicaSet({ name, namespace });
		} catch (error) {
			getErr = toError(error);
			return [undefined, getErr];
		}
	}

	return [undefined, updateErr];
}

// Models kubernetes/pkg/controller/replicaset/replica_set_utils.go calculateStatus.
export function calculateStatus(
	rs: k8s.V1ReplicaSet,
	activePods: k8s.V1Pod[],
	terminatingPods: k8s.V1Pod[],
	manageReplicasErr: Error | undefined,
	controllerFeatures: ReplicaSetControllerFeatures,
	now: Date,
): k8s.V1ReplicaSetStatus {
	const newStatus: k8s.V1ReplicaSetStatus = { replicas: 0, ...(rs.status ?? {}) };
	let fullyLabeledReplicasCount = 0;
	let readyReplicasCount = 0;
	let availableReplicasCount = 0;
	const templateLabel = new LabelSet(rs.spec?.template?.metadata?.labels).asSelectorPreValidated();
	for (const pod of activePods) {
		if (templateLabel.matches(new LabelSet(pod.metadata?.labels))) {
			fullyLabeledReplicasCount++;
		}
		if (podutil.isPodReady(pod)) {
			readyReplicasCount++;
			if (podutil.isPodAvailable(pod, rs.spec?.minReadySeconds ?? 0, now)) {
				availableReplicasCount++;
			}
		}
	}

	const terminatingReplicasCount = controllerFeatures.enableStatusTerminatingReplicas
		? terminatingPods.length
		: undefined;

	const failureCond = getCondition(rs.status, "ReplicaFailure");
	if (manageReplicasErr && !failureCond) {
		let reason = "";
		const diff = activePods.length - (rs.spec?.replicas ?? 1);
		if (diff < 0) {
			reason = "FailedCreate";
		} else if (diff > 0) {
			reason = "FailedDelete";
		}
		const cond = newReplicaSetCondition(
			"ReplicaFailure",
			"True",
			reason,
			manageReplicasErr.message,
			now,
		);
		setCondition(newStatus, cond);
	} else if (!manageReplicasErr && failureCond) {
		removeCondition(newStatus, "ReplicaFailure");
	}

	newStatus.replicas = activePods.length;
	newStatus.fullyLabeledReplicas = fullyLabeledReplicasCount;
	newStatus.readyReplicas = readyReplicasCount;
	newStatus.availableReplicas = availableReplicasCount;
	newStatus.terminatingReplicas = terminatingReplicasCount;
	return newStatus;
}

// Models kubernetes/pkg/controller/replicaset/replica_set_utils.go NewReplicaSetCondition.
export function newReplicaSetCondition(
	condType: string,
	status: string,
	reason: string,
	message: string,
	now: Date,
): k8s.V1ReplicaSetCondition {
	return {
		type: condType,
		status,
		lastTransitionTime: now,
		reason,
		message,
	};
}

// Models kubernetes/pkg/controller/replicaset/replica_set_utils.go GetCondition.
export function getCondition(
	status: k8s.V1ReplicaSetStatus | undefined,
	condType: string,
): k8s.V1ReplicaSetCondition | undefined {
	return (status?.conditions ?? []).find((condition) => condition.type === condType);
}

// Models kubernetes/pkg/controller/replicaset/replica_set_utils.go SetCondition.
export function setCondition(
	status: k8s.V1ReplicaSetStatus,
	condition: k8s.V1ReplicaSetCondition,
): void {
	const currentCond = getCondition(status, condition.type ?? "");
	if (
		currentCond &&
		currentCond.status === condition.status &&
		currentCond.reason === condition.reason
	) {
		return;
	}
	status.conditions = filterOutCondition(status.conditions ?? [], condition.type ?? "");
	status.conditions.push(condition);
}

// Models kubernetes/pkg/controller/replicaset/replica_set_utils.go RemoveCondition.
export function removeCondition(status: k8s.V1ReplicaSetStatus, condType: string): void {
	const conditions = filterOutCondition(status.conditions ?? [], condType);
	status.conditions = conditions.length > 0 ? conditions : undefined;
}

// Models kubernetes/pkg/controller/replicaset/replica_set_utils.go filterOutCondition.
export function filterOutCondition(
	conditions: k8s.V1ReplicaSetCondition[],
	condType: string,
): k8s.V1ReplicaSetCondition[] {
	return conditions.filter((condition) => condition.type !== condType);
}

// Models k8s.io/utils/ptr Equal.
function ptrEqual(left: number | undefined, right: number | undefined): boolean {
	return left === right;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
