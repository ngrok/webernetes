import type { V1ContainerStatus, V1Pod, V1PodCondition, V1PodStatus } from "../../../client";

// Models kubernetes/pkg/kubelet/status/generate.go GeneratePodReadyCondition.
export function generatePodReadyCondition(
	pod: V1Pod,
	oldStatus: V1PodStatus,
	conditions: V1PodCondition[],
	containerStatuses: V1ContainerStatus[],
	phase: V1PodStatus["phase"],
): V1PodCondition {
	const containersReady = generateContainersReadyCondition(
		pod,
		oldStatus,
		containerStatuses,
		phase,
	);
	if (containersReady.status !== "True") {
		return {
			type: "Ready",
			observedGeneration: calculatePodConditionObservedGeneration(
				oldStatus,
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
		const condition = conditions.find(
			(condition) => condition.type === readinessGate.conditionType,
		);
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
			observedGeneration: calculatePodConditionObservedGeneration(
				oldStatus,
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
		observedGeneration: calculatePodConditionObservedGeneration(
			oldStatus,
			pod.metadata?.generation ?? 0,
			"Ready",
		),
		status: "True",
	};
}

// Models kubernetes/pkg/kubelet/status/generate.go GenerateContainersReadyCondition.
export function generateContainersReadyCondition(
	pod: V1Pod,
	oldStatus: V1PodStatus,
	containerStatuses: V1ContainerStatus[] | undefined,
	phase: V1PodStatus["phase"],
): V1PodCondition {
	if (containerStatuses === undefined) {
		return {
			type: "ContainersReady",
			observedGeneration: calculatePodConditionObservedGeneration(
				oldStatus,
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
		const containerStatus = containerStatuses.find((status) => status.name === container.name);
		if (containerStatus) {
			if (!containerStatus.ready) {
				unreadyContainers.push(container.name);
			}
		} else {
			unknownContainers.push(container.name);
		}
	}

	if (phase === "Succeeded" && unknownContainers.length === 0) {
		return generateContainersReadyConditionForTerminalPhase(pod, oldStatus, phase);
	}

	if (phase === "Failed") {
		return generateContainersReadyConditionForTerminalPhase(pod, oldStatus, phase);
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
			observedGeneration: calculatePodConditionObservedGeneration(
				oldStatus,
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
		observedGeneration: calculatePodConditionObservedGeneration(
			oldStatus,
			pod.metadata?.generation ?? 0,
			"ContainersReady",
		),
		status: "True",
	};
}

function generateContainersReadyConditionForTerminalPhase(
	pod: V1Pod,
	oldStatus: V1PodStatus,
	phase: V1PodStatus["phase"],
): V1PodCondition {
	return {
		type: "ContainersReady",
		observedGeneration: calculatePodConditionObservedGeneration(
			oldStatus,
			pod.metadata?.generation ?? 0,
			"ContainersReady",
		),
		status: "False",
		reason: phase === "Failed" ? "PodFailed" : "PodCompleted",
	};
}

// Models kubernetes/pkg/api/v1/pod/util.go CalculatePodConditionObservedGeneration.
function calculatePodConditionObservedGeneration(
	podStatus: V1PodStatus | undefined,
	generation: number,
	_conditionType: V1PodCondition["type"],
): number {
	if (!podStatus) {
		return 0;
	}
	// In Go this does a check against a feature gate called
	// PodObservedGenerationTrackingEnabled, which defaults to true in 1.35 and
	// is slated for removal in 1.38. When true, it just returns generation, so
	// that's all I'm opting to do here.
	return generation;
}

function formatContainerNames(names: string[]): string {
	return `[${names.join(" ")}]`;
}
