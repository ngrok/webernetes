import type { V1Pod } from "../../../client";

// Models kubernetes/pkg/kubelet/container/runtime.go State.
export type State = "Created" | "Running" | "Exited";

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
