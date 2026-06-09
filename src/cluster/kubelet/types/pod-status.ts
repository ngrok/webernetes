/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// Models kubernetes/pkg/kubelet/types/pod_status.go PodConditionsByKubelet.
export const podConditionsByKubelet = [
	"PodScheduled",
	"Ready",
	"Initialized",
	"ContainersReady",
	"PodResizeInProgress",
	"PodResizePending",
];

// Models kubernetes/pkg/kubelet/types/pod_status.go PodConditionByKubelet.
export function podConditionByKubelet(conditionType: string): boolean {
	if (podConditionsByKubelet.includes(conditionType)) {
		return true;
	}
	if (conditionType === "PodReadyToStartContainers") {
		return true;
	}
	if (conditionType === "AllContainersRestarting") {
		return true;
	}
	return false;
}

// Models kubernetes/pkg/kubelet/types/pod_status.go PodConditionSharedByKubelet.
export function podConditionSharedByKubelet(conditionType: string): boolean {
	return conditionType === "DisruptionTarget";
}
