import type { PodStatus as PodRuntimeStatus } from "./container";
import type { Status as ContainerStatus } from "./container";

type ContainerStatusByCreatedList = ContainerStatus[];

// Models kubernetes/pkg/kubelet/pod_container_deletor.go getContainersToDeleteInPod.
export function getContainersToDeleteInPod(
	filterContainerId: string,
	podStatus: PodRuntimeStatus,
	containersToKeep: number,
): ContainerStatusByCreatedList {
	const matchedContainer = (() => {
		if (filterContainerId === "") {
			return undefined;
		}
		for (const containerStatus of podStatus.containerStatuses) {
			if (containerStatus.id.id === filterContainerId) {
				return containerStatus;
			}
		}
		return undefined;
	})();

	if (filterContainerId !== "" && matchedContainer === undefined) {
		return [];
	}

	const candidates: ContainerStatusByCreatedList = [];
	for (const containerStatus of podStatus.containerStatuses) {
		if (containerStatus.state !== "Exited") {
			continue;
		}
		if (matchedContainer === undefined || matchedContainer.name === containerStatus.name) {
			candidates.push(containerStatus);
		}
	}

	if (candidates.length <= containersToKeep) {
		return [];
	}
	candidates.sort((left, right) => right.createdAt - left.createdAt);
	return candidates.slice(containersToKeep);
}
