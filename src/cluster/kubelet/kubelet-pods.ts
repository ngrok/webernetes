import type { V1ContainerStatus, V1Pod, V1PodStatus } from "../../client";
import { containerShouldRestart, getContainerStatus } from "../api/v1/pod/util";
import { isStaticPod } from "./types/pod-update";

// Models kubernetes/pkg/kubelet/kubelet_pods.go truncatePodHostnameIfNeeded hostnameMaxLen.
const hostnameMaxLen = 63;

// Models kubernetes/pkg/kubelet/kubelet_pods.go truncatePodHostnameIfNeeded.
export function truncatePodHostnameIfNeeded(
	podName: string,
	hostname: string,
): [hostname: string, err: Error | undefined] {
	if (hostname.length <= hostnameMaxLen) {
		return [hostname, undefined];
	}
	const truncated = hostname.slice(0, hostnameMaxLen).replace(/[-.]+$/u, "");
	if (truncated.length === 0) {
		return [truncated, new Error(`hostname for pod "${podName}" was invalid: "${hostname}"`)];
	}
	return [truncated, undefined];
}

// Models kubernetes/pkg/kubelet/kubelet_pods.go getPhase.
export function getPhase(
	pod: V1Pod,
	info: V1ContainerStatus[],
	podIsTerminal: boolean,
): NonNullable<V1PodStatus["phase"]> {
	const spec = pod.spec;
	let failedInitializationNotRestartable = 0;

	// counters for restartable init and regular containers
	let unknown = 0;
	let running = 0;
	let waiting = 0;
	let stopped = 0;
	let stoppedNotRestartable = 0;
	let succeeded = 0;

	for (const container of spec?.containers ?? []) {
		const containerStatus = getContainerStatus(info, container.name);
		const ok = containerStatus !== undefined;
		if (!ok) {
			unknown++;
			continue;
		}

		switch (true) {
			case containerStatus.state?.running !== undefined:
				running++;
				break;
			case containerStatus.state?.terminated !== undefined:
				stopped++;
				{
					const exitCode = containerStatus.state.terminated.exitCode;
					let restartable = containerShouldRestart(container, spec, exitCode);
					restartable =
						restartable || containerStatus.state.terminated.reason === "RestartingAllContainers";
					if (!restartable) {
						stoppedNotRestartable++;
					}
					if (exitCode === 0) {
						succeeded++;
					}
				}
				break;
			case containerStatus.state?.waiting !== undefined:
				if (containerStatus.lastState?.terminated) {
					stopped++;
					const exitCode = containerStatus.lastState.terminated.exitCode;
					let restartable = containerShouldRestart(container, spec, exitCode);
					restartable =
						restartable ||
						containerStatus.lastState.terminated.reason === "RestartingAllContainers";
					if (!restartable) {
						stoppedNotRestartable++;
					}
				} else {
					waiting++;
				}
				break;
			default:
				unknown++;
		}
	}

	if (failedInitializationNotRestartable > 0) {
		return "Failed";
	}

	switch (true) {
		case waiting > 0:
			// One or more containers has not been started
			return "Pending";
		case running > 0 && unknown === 0:
			// All containers have been started, and at least
			// one container is running
			return "Running";
		case running === 0 && stopped > 0 && unknown === 0:
			// The pod is terminal so its containers won't be restarted regardless
			// of the restart policy.
			if (podIsTerminal) {
				if (!isStaticPod(pod)) {
					// All regular containers are terminated in success and all restartable
					// init containers are stopped.
					if (stopped === succeeded) {
						return "Succeeded";
					}
					// There is at least one failure
					return "Failed";
				}
			}

			// All containers are terminated
			if (stopped !== stoppedNotRestartable) {
				// At least one containers are in the process of restarting
				return "Running";
			}
			if (stopped === succeeded) {
				return "Succeeded";
			}
			return "Failed";
		default:
			return "Pending";
	}
}
