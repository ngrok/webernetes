/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1Container, V1ContainerStatus } from "../../../client";

// Models kubernetes/pkg/kubelet/util/util.go GetContainerByIndex.
export function getContainerByIndex(
	containers: V1Container[],
	statuses: V1ContainerStatus[],
	idx: number,
): [V1Container | undefined, boolean] {
	if (idx < 0 || idx >= containers.length || idx >= statuses.length) {
		return [undefined, false];
	}
	if (statuses[idx]?.name !== containers[idx]?.name) {
		return [undefined, false];
	}
	return [containers[idx], true];
}
