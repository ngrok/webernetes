/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1ContainerStatus, V1Pod } from "../../../client";

// Models kubernetes/pkg/kubelet/types/types.go SortedContainerStatuses.
export function sortedContainerStatuses(statuses: V1ContainerStatus[]): V1ContainerStatus[] {
	return [...statuses].sort((a, b) => a.name.localeCompare(b.name));
}

// Models kubernetes/pkg/kubelet/types/types.go SortInitContainerStatuses.
export function sortInitContainerStatuses(pod: V1Pod, statuses: V1ContainerStatus[]): void {
	const containers = pod.spec?.initContainers ?? [];
	let current = 0;
	for (const container of containers) {
		for (let j = current; j < statuses.length; j += 1) {
			if (container.name === statuses[j]?.name) {
				const status = statuses[current];
				const otherStatus = statuses[j];
				if (status !== undefined && otherStatus !== undefined) {
					statuses[current] = otherStatus;
					statuses[j] = status;
				}
				current += 1;
				break;
			}
		}
	}
}

// Models kubernetes/pkg/kubelet/types/types.go SortStatusesOfInitContainers.
export function sortStatusesOfInitContainers(
	pod: V1Pod,
	statusMap: Map<string, V1ContainerStatus>,
): V1ContainerStatus[] {
	const containers = pod.spec?.initContainers ?? [];
	const statuses: V1ContainerStatus[] = [];
	for (const container of containers) {
		const status = statusMap.get(container.name);
		if (status) {
			statuses.push(status);
		}
	}
	return statuses;
}
