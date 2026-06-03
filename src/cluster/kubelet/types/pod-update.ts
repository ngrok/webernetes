import type { V1Pod } from "../../../client";
import { isRestartableInitContainer } from "../../api/v1/pod/util";

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
// Models kubernetes/pkg/kubelet/types/pod_update.go FileSource.
export const fileSource = "file";
// Models kubernetes/pkg/kubelet/types/pod_update.go HTTPSource.
export const httpSource = "http";
// Models kubernetes/pkg/kubelet/types/pod_update.go AllSource.
export const allSource = "*";

// Models kubernetes/pkg/apis/scheduling/types.go HighestUserDefinablePriority.
export const highestUserDefinablePriority = 1000000000;
// Models kubernetes/pkg/apis/scheduling/types.go SystemCriticalPriority.
export const systemCriticalPriority = 2 * highestUserDefinablePriority;
// Models kubernetes/pkg/apis/scheduling/types.go SystemNodeCritical.
export const systemNodeCritical = "system-node-critical";

// Models kubernetes/pkg/kubelet/types/pod_update.go PodOperation.
export type PodOperation = "ADD" | "DELETE" | "REMOVE" | "UPDATE" | "RECONCILE";

// Models kubernetes/pkg/kubelet/types/pod_update.go PodUpdate.
export interface PodUpdate {
	pods: V1Pod[];
	op: PodOperation;
	source: string;
}

// Models kubernetes/pkg/kubelet/types/pod_update.go GetValidatedSources.
export function getValidatedSources(sources: string[]): [string[], Error | undefined] {
	const validated: string[] = [];
	for (const source of sources) {
		switch (source) {
			case allSource:
				return [[fileSource, httpSource, apiserverSource], undefined];
			case fileSource:
			case httpSource:
			case apiserverSource:
				validated.push(source);
				break;
			case "":
				break;
			default:
				return [[], new Error(`unknown pod source "${source}"`)];
		}
	}
	return [validated, undefined];
}

// Models kubernetes/pkg/kubelet/types/pod_update.go GetPodSource.
export function getPodSource(pod: V1Pod): [string, Error | undefined] {
	const source = pod.metadata?.annotations?.[configSourceAnnotationKey];
	if (source !== undefined) {
		return [source, undefined];
	}
	return ["", new Error(`cannot get source of pod "${pod.metadata?.uid ?? ""}"`)];
}

// Models kubernetes/pkg/kubelet/types/pod_update.go SyncPodType.
export type SyncPodType = "create" | "kill" | "sync" | "update";
// Models kubernetes/pkg/kubelet/types/pod_update.go SyncPodSync.
export const syncPodSync: SyncPodType = "sync";
// Models kubernetes/pkg/kubelet/types/pod_update.go SyncPodUpdate.
export const syncPodUpdate: SyncPodType = "update";
// Models kubernetes/pkg/kubelet/types/pod_update.go SyncPodCreate.
export const syncPodCreate: SyncPodType = "create";
// Models kubernetes/pkg/kubelet/types/pod_update.go SyncPodKill.
export const syncPodKill: SyncPodType = "kill";

// Models kubernetes/pkg/kubelet/types/pod_update.go SyncPodType.String.
export function syncPodString(sp: SyncPodType | string | number): string {
	switch (sp) {
		case syncPodCreate:
			return "create";
		case syncPodUpdate:
			return "update";
		case syncPodSync:
			return "sync";
		case syncPodKill:
			return "kill";
		default:
			return "unknown";
	}
}

// Models kubernetes/pkg/kubelet/types/pod_update.go IsMirrorPod.
export function isMirrorPod(pod: V1Pod): boolean {
	return pod.metadata?.annotations?.[configMirrorAnnotationKey] !== undefined;
}

// Models kubernetes/pkg/kubelet/types/pod_update.go IsStaticPod.
export function isStaticPod(pod: V1Pod): boolean {
	const [source, err] = getPodSource(pod);
	return err === undefined && source !== apiserverSource;
}

// Models kubernetes/pkg/kubelet/types/pod_update.go IsCriticalPod.
export function isCriticalPod(pod: V1Pod): boolean {
	if (isStaticPod(pod)) {
		return true;
	}
	if (isMirrorPod(pod)) {
		return true;
	}
	if (pod.spec?.priority !== undefined && isCriticalPodBasedOnPriority(pod.spec.priority)) {
		return true;
	}
	return false;
}

// Models kubernetes/pkg/kubelet/types/pod_update.go Preemptable.
export function preemptable(preemptor: V1Pod | undefined, preemptee: V1Pod | undefined): boolean {
	if (preemptor !== undefined && preemptee !== undefined) {
		if (isCriticalPod(preemptor) && !isCriticalPod(preemptee)) {
			return true;
		}
	}
	if (preemptor?.spec?.priority !== undefined && preemptee?.spec?.priority !== undefined) {
		return preemptor.spec.priority > preemptee.spec.priority;
	}
	return false;
}

// Models kubernetes/pkg/kubelet/types/pod_update.go IsCriticalPodBasedOnPriority.
export function isCriticalPodBasedOnPriority(priority: number): boolean {
	return priority >= systemCriticalPriority;
}

// Models kubernetes/pkg/kubelet/types/pod_update.go IsNodeCriticalPod.
export function isNodeCriticalPod(pod: V1Pod): boolean {
	return isCriticalPod(pod) && pod.spec?.priorityClassName === systemNodeCritical;
}

// Models kubernetes/pkg/kubelet/types/pod_update.go HasRestartableInitContainer.
export function hasRestartableInitContainer(pod: V1Pod): boolean {
	for (const container of pod.spec?.initContainers ?? []) {
		if (isRestartableInitContainer(container)) {
			return true;
		}
	}
	return false;
}
