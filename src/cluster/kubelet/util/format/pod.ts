import type { V1Pod } from "../../../../client";

// Models kubernetes/pkg/kubelet/util/format/pod.go Pod.
export function pod(pod: V1Pod | undefined): string {
	if (pod === undefined) {
		return "<nil>";
	}
	return podDesc(pod.metadata?.name ?? "", pod.metadata?.namespace ?? "", pod.metadata?.uid ?? "");
}

// Models kubernetes/pkg/kubelet/util/format/pod.go PodDesc.
export function podDesc(podName: string, podNamespace: string, podUID: string): string {
	return `${podName}_${podNamespace}(${podUID})`;
}
