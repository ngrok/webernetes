import type { V1Pod } from "../../../client";
import type * as context from "../../../go/context";
import type { ContainerStatus, PodRuntimeStatus } from "../../cri";

// Models kubernetes/pkg/kubelet/container/runtime.go ContainerID.
export class ContainerID {
	constructor(
		readonly type: string,
		readonly id: string,
	) {}

	toString(): string {
		return `${this.type}://${this.id}`;
	}
}

// Models kubernetes/pkg/kubelet/container/runtime.go State.
export type State = "Created" | "Running" | "Exited" | "Unknown";

// Models kubernetes/pkg/kubelet/container/runtime.go Pod.
export interface Pod {
	id: string;
	name: string;
	namespace: string;
	createdAt: number;
	containers: Container[];
	sandboxes: Container[];
	timestamp: Date;
}

// Models kubernetes/pkg/kubelet/container/runtime.go Container.
export interface Container {
	id: string;
	name: string;
	image: string;
	imageID: string;
	imageRef: string;
	imageRuntimeHandler: string;
	hash: number;
	state: State;
	podSandboxID: string;
	createdAt: number;
}

// Models kubernetes/pkg/kubelet/container/runtime.go Runtime.
export interface Runtime {
	getPods(all: boolean): Pod[];
	getPod(ctx: context.Context, podUid: string): [pod: Pod | undefined, err: Error | undefined];
	getPodStatus(
		ctx: context.Context,
		pod: Pod,
	): [podStatus: PodRuntimeStatus | undefined, err: Error | undefined];
	killPod(
		pod: V1Pod | undefined,
		runningPod: Pod,
		gracePeriodOverride: number | undefined,
	): Promise<void>;
	deleteContainer(containerID: ContainerID): Promise<void>;
	runInContainer(
		containerID: ContainerID,
		cmd: string[],
		timeoutSeconds?: number,
	): Promise<[output: string, err: Error | undefined]>;
}

// Models kubernetes/pkg/kubelet/container/runtime.go CommandRunner.
export interface CommandRunner {
	runInContainer(
		id: ContainerID,
		cmd: string[],
		timeoutSeconds?: number,
	): Promise<[output: string, err: Error | undefined]>;
}

// Models kubernetes/pkg/kubelet/container/runtime.go PodStatus.FindContainerStatusByName.
export function findContainerStatusByName(
	podStatus: PodRuntimeStatus,
	containerName: string,
): ContainerStatus | undefined {
	return podStatus.containerStatuses.find(
		(containerStatus) => containerStatus.name === containerName,
	);
}

// Models kubernetes/pkg/kubelet/container/runtime.go BuildContainerID.
export function buildContainerID(type: string, id: string): ContainerID {
	return new ContainerID(type, id);
}

// Models kubernetes/pkg/kubelet/container/runtime.go ParseContainerID.
export function parseContainerID(containerID: string | undefined): ContainerID {
	const parts = containerID?.replace(/^"+|"+$/g, "").split("://") ?? [];
	if (parts.length !== 2) {
		return new ContainerID("", "");
	}
	return new ContainerID(parts[0] ?? "", parts[1] ?? "");
}

// Models kubernetes/pkg/kubelet/container/runtime.go GetPodFullName.
export function getPodFullName(pod: V1Pod): string {
	// Use underscore as the delimiter because it is not allowed in pod name
	// (DNS subdomain format), while allowed in the container name format.
	return `${pod.metadata?.name ?? ""}_${pod.metadata?.namespace ?? "default"}`;
}

// Models kubernetes/pkg/kubelet/container/runtime.go BuildPodFullName.
export function buildPodFullName(name: string, namespace: string): string {
	return `${name}_${namespace}`;
}

// Models kubernetes/pkg/kubelet/container/runtime.go ParsePodFullName.
export function parsePodFullName(podFullName: string): [string, string] {
	const parts = podFullName.split("_");
	if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
		throw new Error(`failed to parse the pod full name "${podFullName}"`);
	}
	return [parts[0] ?? "", parts[1] ?? ""];
}

// Models kubernetes/pkg/kubelet/container/runtime.go Pod.ToAPIPod.
export function toAPIPod(pod: Pod): V1Pod {
	return {
		metadata: {
			uid: pod.id,
			name: pod.name,
			namespace: pod.namespace,
		},
		spec: {
			containers: pod.containers.map((container) => ({
				name: container.name,
				image: container.image,
			})),
		},
	};
}
