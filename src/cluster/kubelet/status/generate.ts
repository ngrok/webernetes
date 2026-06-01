import type { V1ContainerStatus, V1Pod, V1PodCondition, V1PodStatus } from "../../../client";
import * as podutil from "../../api/v1/pod/util";
import type { PodStatus as PodRuntimeStatus } from "../container";
import { allContainersRestartCleanedUp, shouldAllContainersRestart } from "../container";

// Models kubernetes/pkg/kubelet/status/generate.go GenerateContainersReadyCondition.
export function generateContainersReadyCondition(
	pod: V1Pod,
	oldPodStatus: V1PodStatus,
	containerStatuses: V1ContainerStatus[] | undefined,
	podPhase: V1PodStatus["phase"],
): V1PodCondition {
	if (containerStatuses === undefined) {
		return {
			type: "ContainersReady",
			observedGeneration: podutil.calculatePodConditionObservedGeneration(
				oldPodStatus,
				pod.metadata?.generation ?? 0,
				"ContainersReady",
			),
			status: "False",
			reason: "UnknownContainerStatuses",
		};
	}

	const unknownContainers: string[] = [];
	const unreadyContainers: string[] = [];

	for (const container of pod.spec?.containers ?? []) {
		const containerStatus = podutil.getContainerStatus(containerStatuses, container.name);
		if (containerStatus) {
			if (!containerStatus.ready) {
				unreadyContainers.push(container.name);
			}
		} else {
			unknownContainers.push(container.name);
		}
	}

	if (podPhase === "Succeeded" && unknownContainers.length === 0) {
		return generateContainersReadyConditionForTerminalPhase(pod, oldPodStatus, podPhase);
	}

	if (podPhase === "Failed") {
		return generateContainersReadyConditionForTerminalPhase(pod, oldPodStatus, podPhase);
	}

	const unreadyMessages: string[] = [];
	if (unknownContainers.length > 0) {
		unreadyMessages.push(
			`containers with unknown status: ${formatContainerNames(unknownContainers)}`,
		);
	}
	if (unreadyContainers.length > 0) {
		unreadyMessages.push(
			`containers with unready status: ${formatContainerNames(unreadyContainers)}`,
		);
	}
	const unreadyMessage = unreadyMessages.join(", ");
	if (unreadyMessage !== "") {
		return {
			type: "ContainersReady",
			observedGeneration: podutil.calculatePodConditionObservedGeneration(
				oldPodStatus,
				pod.metadata?.generation ?? 0,
				"ContainersReady",
			),
			status: "False",
			reason: "ContainersNotReady",
			message: unreadyMessage,
		};
	}

	return {
		type: "ContainersReady",
		observedGeneration: podutil.calculatePodConditionObservedGeneration(
			oldPodStatus,
			pod.metadata?.generation ?? 0,
			"ContainersReady",
		),
		status: "True",
	};
}

// Models kubernetes/pkg/kubelet/status/generate.go GeneratePodReadyCondition.
export function generatePodReadyCondition(
	pod: V1Pod,
	oldPodStatus: V1PodStatus,
	conditions: V1PodCondition[],
	containerStatuses: V1ContainerStatus[],
	phase: V1PodStatus["phase"],
): V1PodCondition {
	const containersReady = generateContainersReadyCondition(
		pod,
		oldPodStatus,
		containerStatuses,
		phase,
	);
	if (containersReady.status !== "True") {
		return {
			type: "Ready",
			observedGeneration: podutil.calculatePodConditionObservedGeneration(
				oldPodStatus,
				pod.metadata?.generation ?? 0,
				"Ready",
			),
			status: containersReady.status,
			reason: containersReady.reason,
			message: containersReady.message,
		};
	}

	const unreadyMessages: string[] = [];
	for (const readinessGate of pod.spec?.readinessGates ?? []) {
		const [, condition] = podutil.getPodConditionFromList(conditions, readinessGate.conditionType);
		if (!condition) {
			unreadyMessages.push(
				`corresponding condition of pod readiness gate "${readinessGate.conditionType}" does not exist.`,
			);
		} else if (condition.status !== "True") {
			unreadyMessages.push(
				`the status of pod readiness gate "${readinessGate.conditionType}" is not "True", but ${condition.status}`,
			);
		}
	}

	if (unreadyMessages.length !== 0) {
		const unreadyMessage = unreadyMessages.join(", ");
		return {
			type: "Ready",
			observedGeneration: podutil.calculatePodConditionObservedGeneration(
				oldPodStatus,
				pod.metadata?.generation ?? 0,
				"Ready",
			),
			status: "False",
			reason: "ReadinessGatesNotReady",
			message: unreadyMessage,
		};
	}

	return {
		type: "Ready",
		observedGeneration: podutil.calculatePodConditionObservedGeneration(
			oldPodStatus,
			pod.metadata?.generation ?? 0,
			"Ready",
		),
		status: "True",
	};
}

// Models kubernetes/pkg/kubelet/status/generate.go generateContainersReadyConditionForTerminalPhase.
export function generateContainersReadyConditionForTerminalPhase(
	pod: V1Pod,
	oldStatus: V1PodStatus,
	phase: V1PodStatus["phase"],
): V1PodCondition {
	return {
		type: "ContainersReady",
		observedGeneration: podutil.calculatePodConditionObservedGeneration(
			oldStatus,
			pod.metadata?.generation ?? 0,
			"ContainersReady",
		),
		status: "False",
		reason: phase === "Failed" ? "PodFailed" : "PodCompleted",
	};
}

// Models kubernetes/pkg/kubelet/status/generate.go generatePodReadyConditionForTerminalPhase.
export function generatePodReadyConditionForTerminalPhase(
	pod: V1Pod,
	oldStatus: V1PodStatus,
	phase: V1PodStatus["phase"],
): V1PodCondition {
	return {
		type: "Ready",
		observedGeneration: podutil.calculatePodConditionObservedGeneration(
			oldStatus,
			pod.metadata?.generation ?? 0,
			"Ready",
		),
		status: "False",
		reason: phase === "Failed" ? "PodFailed" : "PodCompleted",
	};
}

// Models kubernetes/pkg/kubelet/status/generate.go GenerateAllContainersRestartingCondition.
export function generateAllContainersRestartingCondition(
	pod: V1Pod,
	podStatus: PodRuntimeStatus,
	oldPodStatus: V1PodStatus,
	podPhase: V1PodStatus["phase"],
): V1PodCondition {
	if (podPhase === "Succeeded") {
		return {
			type: "AllContainersRestarting",
			status: "False",
			reason: "PodCompleted",
		};
	}
	if (podPhase === "Failed") {
		return {
			type: "AllContainersRestarting",
			status: "False",
			reason: "PodFailed",
		};
	}

	if (!shouldAllContainersRestart(pod, podStatus, oldPodStatus)) {
		return {
			type: "AllContainersRestarting",
			status: "False",
		};
	}
	if (allContainersRestartCleanedUp(pod, podStatus)) {
		return {
			type: "AllContainersRestarting",
			status: "False",
		};
	}
	return {
		type: "AllContainersRestarting",
		status: "True",
		reason: "RestartAllContainersStarted",
		message: "container exited with restart policy rule",
	};
}

function formatContainerNames(names: string[]): string {
	return `[${names.join(" ")}]`;
}
