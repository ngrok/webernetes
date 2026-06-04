import type {
	V1Container,
	V1LifecycleHandler,
	V1Pod,
	V1PodSpec,
	V1PodStatus,
} from "../../../client";
import type * as context from "../../../go/context";
import * as fnv from "../../../fnv";
import * as hashutil from "../../../hashutil";
import * as expansion from "../../../third_party/forked/golang/expansion";
import type { ContainerPort, DnsConfig, PodSandboxState, PortMapping } from "../../cri";
import { containerShouldRestart, findMatchingContainerRestartRule } from "../../api/v1/pod/util";
import {
	buildContainerID,
	findContainerStatusByName,
	type Pod,
	type PodStatus as PodRuntimeStatus,
	type State,
} from "./runtime";
import type { ContainerID, EnvVar, RunContainerOptions } from "./runtime";

// Models kubernetes/pkg/kubelet/container/helpers.go HandlerRunner.
export interface HandlerRunner {
	run(
		ctx: context.Context,
		containerID: ContainerID,
		pod: V1Pod,
		container: V1Container,
		handler: V1LifecycleHandler,
	): Promise<[message: string, err: Error | undefined]>;
}

// Models kubernetes/pkg/kubelet/container/helpers.go RuntimeHelper.
export interface RuntimeHelper {
	generateRunContainerOptions(
		ctx: context.Context,
		pod: V1Pod,
		container: V1Container,
		podIP: string,
		podIPs: string[],
		imageVolumes: unknown,
	): Promise<
		[
			containerOptions: RunContainerOptions | undefined,
			cleanupAction: (() => void) | undefined,
			err: Error | undefined,
		]
	>;
	getPodDNS(
		ctx: context.Context,
		pod: V1Pod,
	): Promise<[dnsConfig: DnsConfig | undefined, err: Error | undefined]>;
	getPodCgroupParent(pod: V1Pod): string;
	getPodDir(podUid: string): string;
	generatePodHostNameAndDomain(
		pod: V1Pod,
	): [hostname: string, hostDomain: string, err: Error | undefined];
	getExtraSupplementalGroupsForPod(pod: V1Pod): number[];
	getOrCreateUserNamespaceMappings(
		pod: V1Pod | undefined,
		runtimeHandler: string,
	): [userNamespace: unknown, err: Error | undefined];
	prepareDynamicResources(ctx: context.Context, pod: V1Pod): Error | undefined;
	unprepareDynamicResources(ctx: context.Context, pod: V1Pod): Error | undefined;
	requestPodReinspect(podUid: string): void;
	requestPodRelist(podUid: string): void;
	podCPUAndMemoryStats(
		ctx: context.Context,
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
	): [podStats: unknown, err: Error | undefined];
	onPodSandboxReady(ctx: context.Context, pod: V1Pod): Error | undefined;
}

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

// Models kubernetes/pkg/kubelet/container/helpers.go HashContainer.
export function hashContainer(container: V1Container): number {
	const hash = fnv.new32a();
	const containerJSON = hashutil.jsonMarshal(pickFieldsToHash(container));
	hashutil.DeepHashObject(hash, containerJSON);
	return hash.sum32();
}

// Models kubernetes/pkg/kubelet/container/helpers.go pickFieldsToHash.
function pickFieldsToHash(container: V1Container): Record<string, string> {
	return {
		image: container.image ?? "",
		name: container.name,
	};
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
			id: buildContainerID(runtimeName, sandbox.id),
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

// Models kubernetes/pkg/kubelet/container/helpers.go ExpandContainerCommandAndArgs.
export function expandContainerCommandAndArgs(
	container: V1Container,
	envs: EnvVar[],
): [command: string[] | undefined, args: string[] | undefined] {
	const envMap = new Map(envs.map((env) => [env.name, env.value]));
	const mapping = expansion.mappingFuncFor(envMap);
	const command = container.command?.map((cmd) => expansion.expand(cmd, mapping));
	const args = container.args?.map((arg) => expansion.expand(arg, mapping));
	return [command, args];
}

// Models kubernetes/pkg/kubelet/container/helpers.go ExpandContainerCommandOnlyStatic.
export function expandContainerCommandOnlyStatic(
	containerCommand: string[] | undefined,
	envs: NonNullable<V1Container["env"]>,
): string[] {
	const mapping = expansion.mappingFuncFor(v1EnvVarsToMap(envs));
	const command: string[] = [];
	if ((containerCommand?.length ?? 0) !== 0) {
		for (const cmd of containerCommand ?? []) {
			command.push(expansion.expand(cmd, mapping));
		}
	}
	return command;
}

// Models kubernetes/pkg/kubelet/container/helpers.go v1EnvVarsToMap.
function v1EnvVarsToMap(envs: NonNullable<V1Container["env"]>): Map<string, string> {
	const result = new Map<string, string>();
	for (const env of envs) {
		result.set(env.name, env.value ?? "");
	}
	return result;
}

// Models kubernetes/pkg/kubelet/container/helpers.go GetContainerSpec.
export function getContainerSpec(pod: V1Pod, containerName: string): V1Container | undefined {
	return pod.spec?.containers?.find((container) => container.name === containerName);
}

// Models kubernetes/pkg/kubelet/container/helpers.go IsHostNetworkPod.
export function isHostNetworkPod(pod: V1Pod): boolean {
	return pod.spec?.hostNetwork === true;
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

// Models kubernetes/pkg/kubelet/container/helpers.go HasAnyRegularContainerStarted.
export function hasAnyRegularContainerStarted(
	spec: V1PodSpec | undefined,
	statuses: NonNullable<V1PodStatus["containerStatuses"]> | undefined,
): boolean {
	if ((statuses?.length ?? 0) === 0) {
		return false;
	}

	const containerNames = new Set((spec?.containers ?? []).map((container) => container.name));
	for (const status of statuses ?? []) {
		if (!containerNames.has(status.name)) {
			continue;
		}
		if (status.state?.running !== undefined || status.state?.terminated !== undefined) {
			return true;
		}
	}

	return false;
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

// Models kubernetes/pkg/kubelet/container/helpers.go ShouldAllContainersRestart.
export function shouldAllContainersRestart(
	pod: V1Pod,
	podStatus: PodRuntimeStatus | undefined,
	apiPodStatus: V1PodStatus | undefined,
): boolean {
	if (apiPodStatus) {
		for (const cond of apiPodStatus.conditions ?? []) {
			if (cond.type === "AllContainersRestarting" && cond.status === "True") {
				return true;
			}
		}
	}

	const nameToAPIStatus = new Map(
		[
			...(apiPodStatus?.initContainerStatuses ?? []),
			...(apiPodStatus?.containerStatuses ?? []),
		].map((status) => [status.name, status]),
	);

	for (const c of [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])]) {
		if (podStatus) {
			const status = findContainerStatusByName(podStatus, c.name);
			if (!status || status.state !== "Exited") {
				continue;
			}
			const rule = findMatchingContainerRestartRule(c, status.exitCode ?? 0);
			if (rule?.action === "RestartAllContainers") {
				return true;
			}
		}
		if (apiPodStatus) {
			const apiStatus = nameToAPIStatus.get(c.name);
			if (!apiStatus?.state?.terminated) {
				continue;
			}
			const rule = findMatchingContainerRestartRule(c, apiStatus.state.terminated.exitCode);
			if (rule?.action === "RestartAllContainers") {
				return true;
			}
		}
	}
	return false;
}

// Models kubernetes/pkg/kubelet/container/helpers.go AllContainersRestartCleanedUp.
export function allContainersRestartCleanedUp(pod: V1Pod, podStatus: PodRuntimeStatus): boolean {
	for (const c of [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])]) {
		if (findContainerStatusByName(podStatus, c.name)) {
			return false;
		}
	}
	return true;
}
