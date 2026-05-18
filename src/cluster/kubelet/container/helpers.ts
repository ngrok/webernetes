import type { V1Container, V1Pod } from "../../../client";
import type { ContainerPort, PodRuntimeStatus, PodSandboxState, PortMapping } from "../../cri";
import { containerShouldRestart } from "../../api/v1/pod/util";
import { buildContainerID, findContainerStatusByName, type Pod, type State } from "./runtime";

export function runtimeProtocol(
	protocol: string | undefined,
): ContainerPort["protocol"] | undefined {
	switch (protocol) {
		case "TCP":
		case "UDP":
		case "SCTP":
			return protocol;
		default:
			return undefined;
	}
}

// Models kubernetes/pkg/kubelet/container/helpers.go ConvertPodStatusToRunningPod.
export function convertPodStatusToRunningPod(
	runtimeName: string,
	podStatus: PodRuntimeStatus,
): Pod {
	return {
		id: podStatus.id,
		name: podStatus.name,
		namespace: podStatus.namespace,
		containers: podStatus.containerStatuses
			.filter((containerStatus) => containerStatus.state === "Running")
			.map((containerStatus) => ({
				id: containerStatus.id,
				name: containerStatus.name,
				image: containerStatus.imageRef,
				imageID: containerStatus.imageRef,
				imageRef: containerStatus.imageRef,
				imageRuntimeHandler: containerStatus.imageRuntimeHandler,
				hash: containerStatus.hash,
				state: containerStatus.state,
				// Rest are intentionally zero values
				podSandboxID: "",
				createdAt: 0,
			})),
		sandboxes: podStatus.sandboxStatuses.map((sandbox) => ({
			id: buildContainerID(runtimeName, sandbox.id).toString(),
			state: sandboxToContainerState(sandbox.state),
			// Rest are intentionally zero values
			name: "",
			image: "",
			imageID: "",
			imageRef: "",
			imageRuntimeHandler: "",
			hash: 0,
			podSandboxID: "",
			createdAt: 0,
		})),
		// Rest are intentionally zero values
		createdAt: 0,
		timestamp: new Date(0),
	};
}

// Models kubernetes/pkg/kubelet/container/helpers.go SandboxToContainerState.
export function sandboxToContainerState(state: PodSandboxState): State {
	switch (state) {
		case "Ready":
			return "Running";
		case "NotReady":
			return "Exited";
		default:
			return "Unknown";
	}
}

// Models kubernetes/pkg/kubelet/container/helpers.go MakePortMappings.
export function makePortMappings(container: V1Container): PortMapping[] {
	const ports: PortMapping[] = [];
	const names = new Set<string>();
	for (const p of container.ports ?? []) {
		const pm: PortMapping = {
			hostPort: p.hostPort,
			containerPort: p.containerPort,
			protocol: runtimeProtocol(p.protocol),
			hostIp: p.hostIP,
		};

		let family = "any";
		if (p.hostIP) {
			family = isIPv6String(p.hostIP) ? "v6" : "v4";
		}

		const name =
			p.name ||
			`${family}-${p.protocol ?? ""}-${p.hostIP ?? ""}:${p.containerPort}:${p.hostPort ?? 0}`;
		if (names.has(name)) {
			continue;
		}
		ports.push(pm);
		names.add(name);
	}
	return ports;
}

function isIPv6String(value: string): boolean {
	return value.includes(":");
}

// Models kubernetes/pkg/kubelet/container/helpers.go ShouldContainerBeRestarted.
export function shouldContainerBeRestarted(
	container: V1Container,
	pod: V1Pod,
	podStatus: PodRuntimeStatus,
): boolean {
	if (pod.metadata?.deletionTimestamp !== undefined) {
		return false;
	}

	const status = findContainerStatusByName(podStatus, container.name);
	if (!status) {
		return true;
	}
	if (status.state === "Running") {
		return false;
	}
	if (status.state === "Unknown" || status.state === "Created") {
		return true;
	}

	return containerShouldRestart(container, pod.spec, status.exitCode ?? 0);
}
