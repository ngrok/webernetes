import type { Clock } from "../../clock";
import { untilWithContext } from "../../apimachinery/pkg/util/wait/backoff";
import { Channel, select } from "../../go/channel";
import * as context from "../../go/context";
import type {
	ContainerID,
	PodStatus as PodRuntimeStatus,
	Runtime,
	Status as ContainerStatus,
} from "./container";

// Models kubernetes/pkg/kubelet/pod_container_deletor.go containerDeletorBufferLimit.
const containerDeletorBufferLimit = 50;

type ContainerStatusByCreatedList = ContainerStatus[];

// Models kubernetes/pkg/kubelet/pod_container_deletor.go podContainerDeletor.
export class PodContainerDeletor {
	constructor(
		private readonly worker: Channel<ContainerID>,
		private readonly containersToKeep: number,
	) {}

	// Models kubernetes/pkg/kubelet/pod_container_deletor.go podContainerDeletor.deleteContainersInPod.
	deleteContainersInPod(
		filterContainerID: string,
		podStatus: PodRuntimeStatus,
		removeAll: boolean,
	): void {
		let containersToKeep = this.containersToKeep;
		if (removeAll) {
			containersToKeep = 0;
			filterContainerID = "";
		}

		for (const candidate of getContainersToDeleteInPod(
			filterContainerID,
			podStatus,
			containersToKeep,
		)) {
			this.worker.trySend(candidate.id);
		}
	}
}

// Models kubernetes/pkg/kubelet/pod_container_deletor.go newPodContainerDeletor.
export function newPodContainerDeletor(
	ctx: context.Context,
	runtime: Runtime,
	containersToKeep: number,
	clock: Clock,
): PodContainerDeletor {
	const buffer = new Channel<ContainerID>(containerDeletorBufferLimit);
	void untilWithContext(
		ctx,
		async (ctx) => {
			const id = await select()
				.case(ctx.done(), () => undefined)
				.case(buffer, ({ ok, value }) => (ok ? value : undefined));
			if (!id) {
				return;
			}
			const err = await runtime.deleteContainer(context.background(), id);
			if (err) {
				// The simulator does not currently model klog; upstream logs this error
				// and continues processing deletion requests.
			}
		},
		0,
		clock,
	);
	return new PodContainerDeletor(buffer, containersToKeep);
}

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
