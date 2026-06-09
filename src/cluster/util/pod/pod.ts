/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import {
	PatchStrategy,
	setHeaderOptions,
	type V1Pod,
	type V1PodCondition,
	type V1PodStatus,
} from "../../../client";
import type { KubeClient } from "../../cluster";
import * as podutil from "../../api/v1/pod/util";
import { deepEqual, dropUndefinedFields } from "../../../deep-equal";

export interface PatchPodStatusResult {
	pod: V1Pod | undefined;
	patchBytes: string;
	unchanged: boolean;
}

// Models kubernetes/pkg/util/pod/pod.go PatchPodStatus.
export async function patchPodStatus(
	c: KubeClient,
	namespace: string,
	name: string,
	uid: string,
	oldPodStatus: V1PodStatus,
	newPodStatus: V1PodStatus,
): Promise<PatchPodStatusResult> {
	const { patchBytes, unchanged } = preparePatchBytesForPodStatus(uid, oldPodStatus, newPodStatus);
	if (unchanged) {
		return { pod: undefined, patchBytes, unchanged: true };
	}

	try {
		// Kubernetes sends a strategic-merge patch here. The simulator's patch
		// implementation uses object merge semantics, which is equivalent for this
		// helper because the patch contains the complete merged status plus the UID
		// precondition, so applying it produces the same stored pod status.
		const pod = await c.corev1.patchNamespacedPodStatus(
			{
				namespace,
				name,
				body: JSON.parse(patchBytes),
			},
			setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
		);
		return { pod, patchBytes, unchanged: false };
	} catch (error) {
		throw new Error(
			`failed to patch status ${patchBytes} for pod "${namespace}/${name}": ${String(error)}`,
			{ cause: error },
		);
	}
}

// DOES NOT model kubernetes/pkg/util/pod/pod.go preparePatchBytesForPodStatus
// upstream uses a strategicpatch.CreateTwoWayMergePatch helper that we don't
// because we're not doing a strategic patch.
function preparePatchBytesForPodStatus(
	uid: string,
	oldPodStatus: V1PodStatus,
	newPodStatus: V1PodStatus,
): { patchBytes: string; unchanged: boolean } {
	if (deepEqual(toJsonValue(oldPodStatus), toJsonValue(newPodStatus))) {
		return {
			patchBytes: JSON.stringify({ metadata: { uid } }),
			unchanged: true,
		};
	}
	return {
		patchBytes: JSON.stringify({
			metadata: { uid },
			status: newPodStatus,
		}),
		unchanged: false,
	};
}

function toJsonValue(value: unknown): unknown {
	return JSON.parse(JSON.stringify(dropUndefinedFields(value)));
}

// Models kubernetes/pkg/util/pod/pod.go ReplaceOrAppendPodCondition.
export function replaceOrAppendPodCondition(
	conditions: V1PodCondition[] | undefined,
	condition: V1PodCondition,
): V1PodCondition[] {
	if (!conditions) {
		return [condition];
	}

	const [index] = podutil.getPodConditionFromList(conditions, condition.type);
	if (index >= 0) {
		conditions[index] = condition;
	} else {
		conditions = [...conditions, condition];
	}
	return conditions;
}
