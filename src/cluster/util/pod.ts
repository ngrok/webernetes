import {
	PatchStrategy,
	setHeaderOptions,
	type V1Pod,
	type V1PodCondition,
	type V1PodStatus,
} from "../../client";
import type { KubeClient } from "../cluster";
import { deepEqual } from "../../deep-equal";

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
		return { pod: undefined, patchBytes, unchanged };
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
		return { pod, patchBytes, unchanged };
	} catch (error) {
		throw new Error(
			`failed to patch status ${patchBytes} for pod "${namespace}/${name}": ${String(error)}`,
			{ cause: error },
		);
	}
}

function preparePatchBytesForPodStatus(
	uid: string,
	oldPodStatus: V1PodStatus,
	newPodStatus: V1PodStatus,
): { patchBytes: string; unchanged: boolean } {
	if (deepEqual(oldPodStatus, newPodStatus)) {
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

// Models kubernetes/pkg/util/pod/pod.go ReplaceOrAppendPodCondition.
export function replaceOrAppendPodCondition(
	conditions: V1PodCondition[] | undefined,
	condition: V1PodCondition,
): V1PodCondition[] {
	if (!conditions) {
		return [condition];
	}

	const index = conditions.findIndex((existing) => existing.type === condition.type);
	if (index === -1) {
		return [...conditions, condition];
	}
	conditions[index] = condition;
	return conditions;
}
