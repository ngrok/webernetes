import type { V1PodStatus } from "../../../client";

// Models kubernetes/pkg/kubelet/eviction/helpers.go Reason.
export const reason = "Evicted";

// Models kubernetes/pkg/kubelet/eviction/helpers.go PodIsEvicted.
export function podIsEvicted(podStatus: V1PodStatus | undefined): boolean {
	return podStatus?.phase === "Failed" && podStatus.reason === reason;
}
