import type { V1Container, V1Pod, V1PodCondition, V1PodStatus } from "../client";
import type { Clock } from "../clock";

// Models kubernetes/pkg/api/v1/pod/util.go GetContainerStatus.
export function getContainerStatus(
	statuses: V1PodStatus["containerStatuses"],
	name: string,
): NonNullable<V1PodStatus["containerStatuses"]>[number] | undefined {
	return statuses?.find((status) => status.name === name);
}

// Models kubernetes/pkg/api/v1/pod/util.go GetPodConditionFromList.
export function getPodConditionFromList(
	conditions: V1PodCondition[] | undefined,
	conditionType: V1PodCondition["type"],
): V1PodCondition | undefined {
	return conditions?.find((condition) => condition.type === conditionType);
}

// Models kubernetes/pkg/api/v1/pod/util.go GetPodCondition.
export function getPodCondition(
	status: V1PodStatus | undefined,
	conditionType: V1PodCondition["type"],
): V1PodCondition | undefined {
	if (!status) {
		return undefined;
	}
	return getPodConditionFromList(status.conditions, conditionType);
}

// Models kubernetes/pkg/api/v1/pod/util.go CalculatePodConditionObservedGeneration.
export function calculatePodConditionObservedGeneration(
	podStatus: V1PodStatus | undefined,
	generation: number,
	_conditionType: V1PodCondition["type"],
): number {
	if (!podStatus) {
		return 0;
	}
	// In Go this checks the PodObservedGenerationTrackingEnabled feature gate.
	// It defaults to true in 1.35 and is slated for removal in 1.38.
	return generation;
}

// Models kubernetes/pkg/api/v1/pod/util.go CalculatePodStatusObservedGeneration.
export function calculatePodStatusObservedGeneration(pod: V1Pod): number {
	if ((pod.status?.observedGeneration ?? 0) !== 0) {
		return pod.metadata?.generation ?? 0;
	}
	// In Go this checks the PodObservedGenerationTracking feature gate.
	// It defaults to true in 1.35 and is slated for removal in 1.38.
	return pod.metadata?.generation ?? 0;
}

// Models kubernetes/pkg/api/v1/pod/util.go IsPodPhaseTerminal.
export function isPodPhaseTerminal(phase: V1PodStatus["phase"]): boolean {
	return phase === "Failed" || phase === "Succeeded";
}

// Models kubernetes/pkg/api/v1/pod/util.go IsPodReadyConditionTrue.
export function isPodReadyConditionTrue(status: V1PodStatus): boolean {
	return getPodConditionFromList(status.conditions, "Ready")?.status === "True";
}

// Models kubernetes/pkg/api/v1/pod/util.go IsContainersReadyConditionTrue.
export function isContainersReadyConditionTrue(status: V1PodStatus): boolean {
	return getPodConditionFromList(status.conditions, "ContainersReady")?.status === "True";
}

// Models kubernetes/pkg/api/v1/pod/util.go UpdatePodCondition.
export function updatePodCondition(
	clock: Clock,
	status: V1PodStatus,
	condition: V1PodCondition,
): boolean {
	condition.lastTransitionTime = clock.now();
	const oldCondition = getPodCondition(status, condition.type);
	if (!oldCondition) {
		status.conditions = [...(status.conditions ?? []), condition];
		return true;
	}
	if (condition.status === oldCondition.status) {
		condition.lastTransitionTime = oldCondition.lastTransitionTime;
	}
	const isEqual =
		condition.status === oldCondition.status &&
		condition.reason === oldCondition.reason &&
		condition.message === oldCondition.message &&
		condition.lastProbeTime?.getTime() === oldCondition.lastProbeTime?.getTime() &&
		condition.lastTransitionTime?.getTime() === oldCondition.lastTransitionTime?.getTime();

	const index = status.conditions?.findIndex((existing) => existing.type === condition.type) ?? -1;
	if (index !== -1 && status.conditions) {
		status.conditions[index] = condition;
	}
	return !isEqual;
}

// Models kubernetes/pkg/api/v1/pod/util.go ContainerShouldRestart.
export function containerShouldRestart(
	container: V1Container,
	podSpec: V1Pod["spec"],
	exitCode: number,
): boolean {
	if (container.restartPolicy !== undefined) {
		const rule = findMatchingContainerRestartRule(container, exitCode);
		if (rule) {
			switch (rule.action) {
				case "Restart":
					return true;
				case "RestartAllContainers":
					// The default as of 1.36, see feature gate
					// RestartAllContainersOnContainerExits.
					return true;
			}
		}

		switch (container.restartPolicy) {
			case "Always":
				return true;
			case "OnFailure":
				return exitCode !== 0;
			case "Never":
				return false;
		}
	}

	switch (podSpec?.restartPolicy) {
		case "Always":
			return true;
		case "OnFailure":
			return exitCode !== 0;
		case "Never":
			return false;
		default:
			return true;
	}
}

// Models kubernetes/pkg/api/v1/pod/util.go FindMatchingContainerRestartRule.
export function findMatchingContainerRestartRule(
	container: V1Container,
	exitCode: number,
): NonNullable<V1Container["restartPolicyRules"]>[number] | undefined {
	for (const rule of container.restartPolicyRules ?? []) {
		if (rule.exitCodes) {
			const exitCodeMatched = (rule.exitCodes.values ?? []).includes(exitCode);
			switch (rule.exitCodes.operator) {
				case "In":
					if (exitCodeMatched) {
						return rule;
					}
					break;
				case "NotIn":
					if (!exitCodeMatched) {
						return rule;
					}
					break;
			}
		}
	}
	return undefined;
}

// Models kubernetes/pkg/api/v1/pod/util.go AllContainersCouldRestart.
export function allContainersCouldRestart(podSpec: V1Pod["spec"]): boolean {
	if (!podSpec) {
		return false;
	}
	for (const container of podSpec.initContainers ?? []) {
		for (const rule of container.restartPolicyRules ?? []) {
			if (rule.action === "RestartAllContainers") {
				return true;
			}
		}
	}
	for (const container of podSpec.containers ?? []) {
		for (const rule of container.restartPolicyRules ?? []) {
			if (rule.action === "RestartAllContainers") {
				return true;
			}
		}
	}
	return false;
}
