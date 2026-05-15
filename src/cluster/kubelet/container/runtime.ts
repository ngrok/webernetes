import type { V1Pod } from "../../../client";

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
