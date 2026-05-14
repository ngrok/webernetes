import type { V1Container, V1Pod, V1PodCondition, V1PodStatus } from "../client";

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
