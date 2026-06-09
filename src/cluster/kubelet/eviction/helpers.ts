/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1PodStatus } from "../../../client";

// Models kubernetes/pkg/kubelet/eviction/helpers.go Reason.
export const reason = "Evicted";

// Models kubernetes/pkg/kubelet/eviction/helpers.go PodIsEvicted.
export function podIsEvicted(podStatus: V1PodStatus | undefined): boolean {
	return podStatus?.phase === "Failed" && podStatus.reason === reason;
}
