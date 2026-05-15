import type { V1Pod } from "../../../client";

// Models kubernetes/pkg/kubelet/types/pod_update.go ConfigSourceAnnotationKey.
export const configSourceAnnotationKey = "kubernetes.io/config.source";
// Models kubernetes/pkg/kubelet/types/pod_update.go ConfigMirrorAnnotationKey.
export const configMirrorAnnotationKey = "kubernetes.io/config.mirror";
// Models kubernetes/pkg/kubelet/types/pod_update.go ConfigFirstSeenAnnotationKey.
export const configFirstSeenAnnotationKey = "kubernetes.io/config.seen";
// Models kubernetes/pkg/kubelet/types/pod_update.go ConfigHashAnnotationKey.
export const configHashAnnotationKey = "kubernetes.io/config.hash";

// Models kubernetes/pkg/kubelet/types/pod_update.go ApiserverSource.
export const apiserverSource = "api";

// Models kubernetes/pkg/kubelet/types/pod_update.go IsMirrorPod.
export function isMirrorPod(pod: V1Pod): boolean {
	return pod.metadata?.annotations?.[configMirrorAnnotationKey] !== undefined;
}

// Models kubernetes/pkg/kubelet/types/pod_update.go IsStaticPod.
export function isStaticPod(pod: V1Pod): boolean {
	const source = pod.metadata?.annotations?.[configSourceAnnotationKey];
	return source !== undefined && source !== apiserverSource;
}
