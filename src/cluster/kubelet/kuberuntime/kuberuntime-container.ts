import type { V1Container, V1Pod } from "../../../client";
import type { ContainerFilter, PodSandboxFilter } from "../../cri/runtime/v1/api";
import {
	findContainerStatusByName,
	type ContainerID,
	type PodStatus as PodRuntimeStatus,
} from "../container";
import type * as context from "../../../go/context";
import { kubernetesPodUIDLabel } from "./labels";

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go startSpec.
export interface StartSpec {
	container: V1Container;
}

export type ContainerKillReason =
	| "StartupProbe"
	| "LivenessProbe"
	| "FailedPostStartHook"
	| "RestartAllContainers"
	| "Unknown";

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go minimumGracePeriodInSeconds.
export const minimumGracePeriodInSeconds = 2;

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go listOptions.
export interface ListOptions {
	podUID?: string;
	onlyRunningReady?: boolean;
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go listOptions.containerFilter.
export function containerFilter(opts: ListOptions): ContainerFilter {
	const filter: ContainerFilter = {};
	if (opts.podUID !== undefined) {
		filter.labelSelector = { [kubernetesPodUIDLabel]: opts.podUID };
	}
	if (opts.onlyRunningReady) {
		filter.state = { state: "Running" };
	}
	return filter;
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go listOptions.sandboxFilter.
export function sandboxFilter(opts: ListOptions): PodSandboxFilter {
	const filter: PodSandboxFilter = {};
	if (opts.podUID !== undefined) {
		filter.labelSelector = { [kubernetesPodUIDLabel]: opts.podUID };
	}
	if (opts.onlyRunningReady) {
		filter.state = { state: "Ready" };
	}
	return filter;
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go setTerminationGracePeriod.
export function setTerminationGracePeriod(
	ctx: context.Context,
	pod: V1Pod,
	containerSpec: V1Container,
	containerName: string,
	containerID: ContainerID,
	reason: ContainerKillReason,
): number {
	let gracePeriod = minimumGracePeriodInSeconds;
	if (pod.metadata?.deletionGracePeriodSeconds !== undefined) {
		return pod.metadata.deletionGracePeriodSeconds;
	}
	if (pod.spec?.terminationGracePeriodSeconds !== undefined) {
		switch (reason) {
			case "StartupProbe":
				if (
					isProbeTerminationGracePeriodSecondsSet(
						ctx,
						pod,
						containerSpec,
						containerSpec.startupProbe,
						containerName,
						containerID,
						"StartupProbe",
					)
				) {
					return containerSpec.startupProbe?.terminationGracePeriodSeconds ?? gracePeriod;
				}
				break;
			case "LivenessProbe":
				if (
					isProbeTerminationGracePeriodSecondsSet(
						ctx,
						pod,
						containerSpec,
						containerSpec.livenessProbe,
						containerName,
						containerID,
						"LivenessProbe",
					)
				) {
					return containerSpec.livenessProbe?.terminationGracePeriodSeconds ?? gracePeriod;
				}
				break;
		}
		return pod.spec.terminationGracePeriodSeconds;
	}
	return gracePeriod;
}

function isProbeTerminationGracePeriodSecondsSet(
	ctx: context.Context,
	_pod: V1Pod,
	_containerSpec: V1Container,
	probe: V1Container["startupProbe"] | V1Container["livenessProbe"] | undefined,
	_containerName: string,
	_containerID: ContainerID,
	_probeType: string,
): boolean {
	void ctx;
	return probe?.terminationGracePeriodSeconds !== undefined;
}

export function isNotFoundError(err: Error): boolean {
	return /\bNotFound\b|No such container|not found/.test(err.message);
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go getTerminationMessage.
export function getTerminationMessage(
	_status: unknown,
	terminationMessagePath: string,
	fallbackToLogs: boolean,
): [message: string, checkLogs: boolean] {
	if (terminationMessagePath.length === 0) {
		return ["", fallbackToLogs];
	}
	// The simulator does not model container termination-message volume mounts.
	return ["", fallbackToLogs];
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go HasAnyRegularContainerCreated.
export function hasAnyRegularContainerCreated(pod: V1Pod, podStatus: PodRuntimeStatus): boolean {
	for (const container of pod.spec?.containers ?? []) {
		const status = findContainerStatusByName(podStatus, container.name);
		if (!status) {
			continue;
		}
		switch (status.state) {
			case "Created":
			case "Running":
			case "Exited":
				return true;
			default:
				break;
		}
	}
	return false;
}
