import type { V1Container, V1ContainerPort, V1LifecycleHandler, V1Pod } from "../../../client";
import type * as context from "../../../go/context";
import { hashContainer, type RunContainerOptions } from "../container";

export const kubernetesPodNameLabel = "io.kubernetes.pod.name";
export const kubernetesPodNamespaceLabel = "io.kubernetes.pod.namespace";
export const kubernetesPodUIDLabel = "io.kubernetes.pod.uid";
export const kubernetesContainerNameLabel = "io.kubernetes.container.name";

const podDeletionGracePeriodLabel = "io.kubernetes.pod.deletionGracePeriod";
const podTerminationGracePeriodLabel = "io.kubernetes.pod.terminationGracePeriod";
const containerHashLabel = "io.kubernetes.container.hash";
const containerRestartCountLabel = "io.kubernetes.container.restartCount";
const containerTerminationMessagePathLabel = "io.kubernetes.container.terminationMessagePath";
const containerTerminationMessagePolicyLabel = "io.kubernetes.container.terminationMessagePolicy";
const containerPreStopHandlerLabel = "io.kubernetes.container.preStopHandler";
const containerPortsLabel = "io.kubernetes.container.ports";

// Models kubernetes/pkg/kubelet/kuberuntime/labels.go newContainerLabels.
export function newContainerLabels(container: V1Container, pod: V1Pod): Record<string, string> {
	return {
		[kubernetesPodNameLabel]: pod.metadata?.name ?? "",
		[kubernetesPodNamespaceLabel]: pod.metadata?.namespace ?? "default",
		[kubernetesPodUIDLabel]: pod.metadata?.uid ?? "",
		[kubernetesContainerNameLabel]: container.name,
	};
}

// Models kubernetes/pkg/kubelet/kuberuntime/labels.go newPodLabels.
export function newPodLabels(pod: V1Pod): Record<string, string> {
	return {
		...(pod.metadata?.labels ?? {}),
		[kubernetesPodNameLabel]: pod.metadata?.name ?? "",
		[kubernetesPodNamespaceLabel]: pod.metadata?.namespace ?? "default",
		[kubernetesPodUIDLabel]: pod.metadata?.uid ?? "",
	};
}

// Models kubernetes/pkg/kubelet/kuberuntime/labels.go newPodAnnotations.
export function newPodAnnotations(pod: V1Pod): Record<string, string> {
	return { ...(pod.metadata?.annotations ?? {}) };
}

// Models kubernetes/pkg/kubelet/kuberuntime/labels.go newContainerAnnotations.
export function newContainerAnnotations(
	_ctx: context.Context,
	container: V1Container,
	pod: V1Pod,
	restartCount: number,
	opts: RunContainerOptions,
): Record<string, string> {
	const annotations: Record<string, string> = {};
	for (const annotation of opts.annotations ?? []) {
		annotations[annotation.name] = annotation.value;
	}

	annotations[containerHashLabel] = hashContainer(container).toString(16);
	annotations[containerRestartCountLabel] = String(restartCount);
	annotations[containerTerminationMessagePathLabel] = container.terminationMessagePath ?? "";
	annotations[containerTerminationMessagePolicyLabel] = container.terminationMessagePolicy ?? "";

	if (pod.metadata?.deletionGracePeriodSeconds !== undefined) {
		annotations[podDeletionGracePeriodLabel] = String(pod.metadata.deletionGracePeriodSeconds);
	}
	if (pod.spec?.terminationGracePeriodSeconds !== undefined) {
		annotations[podTerminationGracePeriodLabel] = String(pod.spec.terminationGracePeriodSeconds);
	}
	if (container.lifecycle?.preStop) {
		const rawPreStop = stringifyAnnotation(container.lifecycle.preStop);
		if (rawPreStop !== undefined) {
			annotations[containerPreStopHandlerLabel] = rawPreStop;
		}
	}
	if ((container.ports?.length ?? 0) > 0) {
		const rawContainerPorts = stringifyAnnotation(container.ports);
		if (rawContainerPorts !== undefined) {
			annotations[containerPortsLabel] = rawContainerPorts;
		}
	}
	return annotations;
}

function stringifyAnnotation(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

// Models kubernetes/pkg/kubelet/kuberuntime/labels.go getContainerInfoFromLabels.
export function getContainerInfoFromLabels(labels: Record<string, string>): {
	podName: string;
	podNamespace: string;
	podUID: string;
	containerName: string;
} {
	return {
		podName: labels[kubernetesPodNameLabel] ?? "",
		podNamespace: labels[kubernetesPodNamespaceLabel] ?? "default",
		podUID: labels[kubernetesPodUIDLabel] ?? "",
		containerName: labels[kubernetesContainerNameLabel] ?? "",
	};
}

interface AnnotatedContainerInfo {
	hash: number;
	restartCount: number;
	podDeletionGracePeriod?: number;
	podTerminationGracePeriod?: number;
	terminationMessagePath: string;
	terminationMessagePolicy: string;
	preStopHandler?: V1LifecycleHandler;
	containerPorts: V1ContainerPort[];
}

// Models kubernetes/pkg/kubelet/kuberuntime/labels.go getContainerInfoFromAnnotations.
export function getContainerInfoFromAnnotations(
	ctx: context.Context,
	annotations: Record<string, string>,
): AnnotatedContainerInfo {
	void ctx;
	return {
		terminationMessagePath: getStringValueFromLabel(
			annotations,
			containerTerminationMessagePathLabel,
		),
		terminationMessagePolicy: getStringValueFromLabel(
			annotations,
			containerTerminationMessagePolicyLabel,
		),
		hash: getUint64ValueFromLabel(annotations, containerHashLabel),
		restartCount: getIntValueFromLabel(annotations, containerRestartCountLabel),
		podDeletionGracePeriod: getInt64PointerFromLabel(annotations, podDeletionGracePeriodLabel),
		podTerminationGracePeriod: getInt64PointerFromLabel(
			annotations,
			podTerminationGracePeriodLabel,
		),
		preStopHandler: getJSONObjectFromLabel<V1LifecycleHandler>(
			annotations,
			containerPreStopHandlerLabel,
		),
		containerPorts:
			getJSONObjectFromLabel<V1ContainerPort[]>(annotations, containerPortsLabel) ?? [],
	};
}

function getStringValueFromLabel(labels: Record<string, string>, label: string): string {
	return labels[label] ?? "";
}

function getIntValueFromLabel(labels: Record<string, string>, label: string): number {
	const value = labels[label];
	if (value === undefined) {
		return 0;
	}
	return Number.parseInt(value, 10) || 0;
}

function getUint64ValueFromLabel(labels: Record<string, string>, label: string): number {
	const value = labels[label];
	if (value === undefined) {
		return 0;
	}
	return Number.parseInt(value, 16) || 0;
}

function getInt64PointerFromLabel(
	labels: Record<string, string>,
	label: string,
): number | undefined {
	const value = labels[label];
	if (value === undefined) {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function getJSONObjectFromLabel<T>(labels: Record<string, string>, label: string): T | undefined {
	const value = labels[label];
	if (value === undefined) {
		return undefined;
	}
	try {
		return JSON.parse(value) as T;
	} catch {
		return undefined;
	}
}
