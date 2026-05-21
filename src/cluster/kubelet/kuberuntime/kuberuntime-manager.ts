import type { V1Container, V1Pod } from "../../../client";
import type { Clock } from "../../../clock";
import { KeyFnMap } from "../../../collections";
import { Channel, select } from "../../../go/channel";
import * as context from "../../../go/context";
import * as time from "../../../go/time";
import type {
	ContainerConfig,
	ContainerStatus,
	PodRuntimeStatus,
	PodSandboxConfig,
	PortMapping,
	RuntimeService,
} from "../../cri";
import { findMatchingContainerRestartRule } from "../../api/v1/pod/util";
import {
	buildContainerID,
	findContainerStatusByName,
	generateContainerRef,
	hashContainer,
	isHostNetworkPod,
	makePortMappings,
	runtimeProtocol,
	shouldContainerBeRestarted,
} from "../container";
import type { ContainerID, RunContainerOptions, RuntimeHelper } from "../container";
import type { EventRecorder } from "../../events";
import type { ImageManager } from "../images";
import type { ResultsManager } from "../prober/results";
import type { InternalContainerLifecycle } from "../cm";
import type { HandlerRunner } from "../container";
import { getNodenameForKernel, podSandboxChanged } from "./util/util";
import type { StartSpec } from "./kuberuntime-container";

type RuntimeError = Error | undefined;
type CleanupAction = (() => void) | undefined;

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go ErrCreateContainerConfig.
const errCreateContainerConfig = new Error("CreateContainerConfigError");
// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go ErrCreateContainer.
const errCreateContainer = new Error("CreateContainerError");
// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go ErrPreCreateHook.
const errPreCreateHook = new Error("PreCreateHookError");
// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go ErrPreStartHook.
const errPreStartHook = new Error("PreStartHookError");
// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go ErrPostStartHook.
const errPostStartHook = new Error("PostStartHookError");
// Models kubernetes/pkg/kubelet/container/sync_result.go ErrRunContainer.
const errRunContainer = new Error("RunContainerError");

const kubernetesPodNameLabel = "io.kubernetes.pod.name";
const kubernetesPodNamespaceLabel = "io.kubernetes.pod.namespace";
const kubernetesPodUIDLabel = "io.kubernetes.pod.uid";
const kubernetesContainerNameLabel = "io.kubernetes.container.name";

const podDeletionGracePeriodLabel = "io.kubernetes.pod.deletionGracePeriod";
const podTerminationGracePeriodLabel = "io.kubernetes.pod.terminationGracePeriod";
const containerHashLabel = "io.kubernetes.container.hash";
const containerRestartCountLabel = "io.kubernetes.container.restartCount";
const containerTerminationMessagePathLabel = "io.kubernetes.container.terminationMessagePath";
const containerTerminationMessagePolicyLabel = "io.kubernetes.container.terminationMessagePolicy";
const containerPreStopHandlerLabel = "io.kubernetes.container.preStopHandler";
const containerPortsLabel = "io.kubernetes.container.ports";

// Models kubernetes/pkg/kubelet/kuberuntime/labels.go newContainerLabels.
function newContainerLabels(container: V1Container, pod: V1Pod): Record<string, string> {
	return {
		[kubernetesPodNameLabel]: pod.metadata?.name ?? "",
		[kubernetesPodNamespaceLabel]: pod.metadata?.namespace ?? "default",
		[kubernetesPodUIDLabel]: pod.metadata?.uid ?? "",
		[kubernetesContainerNameLabel]: container.name,
	};
}

// Models kubernetes/pkg/kubelet/kuberuntime/labels.go newContainerAnnotations.
function newContainerAnnotations(
	ctx: context.Context,
	container: V1Container,
	pod: V1Pod,
	restartCount: number,
	opts: RunContainerOptions,
): Record<string, string> {
	void ctx;
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

export interface KubeGenericRuntimeManagerOptions {
	runtimeService: RuntimeService;
	runtimeHelper: RuntimeHelper;
	imagePuller: ImageManager;
	events: EventRecorder;
	internalLifecycle: InternalContainerLifecycle;
	livenessManager: ResultsManager;
	runner: HandlerRunner;
	startupManager: ResultsManager;
	clock: Clock;
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.
export class KubeGenericRuntimeManager {
	private readonly runtimeService: RuntimeService;
	private readonly runtimeHelper: RuntimeHelper;
	private readonly imagePuller: ImageManager;
	private readonly events: EventRecorder;
	private readonly internalLifecycle: InternalContainerLifecycle;
	private readonly livenessManager: ResultsManager;
	private readonly runner: HandlerRunner;
	private readonly startupManager: ResultsManager;
	private readonly clock: Clock;

	constructor(options: KubeGenericRuntimeManagerOptions) {
		this.runtimeService = options.runtimeService;
		this.runtimeHelper = options.runtimeHelper;
		this.imagePuller = options.imagePuller;
		this.events = options.events;
		this.internalLifecycle = options.internalLifecycle;
		this.livenessManager = options.livenessManager;
		this.runner = options.runner;
		this.startupManager = options.startupManager;
		this.clock = options.clock;
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go recordContainerEvent.
	private async recordContainerEvent(
		ctx: context.Context,
		pod: V1Pod,
		container: V1Container,
		containerID: string,
		eventType: "Normal" | "Warning",
		reason: string,
		message: string,
		...args: string[]
	): Promise<void> {
		void ctx;
		const [ref, err] = generateContainerRef(pod, container);
		if (err || !ref) {
			return;
		}
		let eventMessage = message;
		if (args.length > 0) {
			let index = 0;
			eventMessage = message.replace(/%[sdv]/g, () => args[index++] ?? "");
		}
		if (containerID !== "") {
			eventMessage = eventMessage.replaceAll(containerID, container.name);
		}
		await this.events.event(ref, eventType, reason, eventMessage);
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go startContainer.
	async startContainer(
		ctx: context.Context,
		podSandboxID: string,
		podSandboxConfig: PodSandboxConfig,
		spec: StartSpec,
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
		_pullSecrets: unknown[],
		podIP: string,
		podIPs: string[],
		imageVolumes: unknown,
	): Promise<[message: string, err: RuntimeError]> {
		const container = spec.container;

		let [ref, err] = generateContainerRef(pod, container);
		if (err) {
			ref = undefined;
		}

		const [imageRef, imageMessage, imageErr] = await this.imagePuller.ensureImageExists(
			ctx,
			ref,
			pod,
			container.image ?? "",
			_pullSecrets,
			podSandboxConfig,
			"",
			container.imagePullPolicy,
		);
		if (imageErr) {
			await this.recordContainerEvent(
				ctx,
				pod,
				container,
				"",
				"Warning",
				"Failed",
				"Error: %v",
				imageErr.message,
			);
			return [imageMessage, imageErr];
		}

		let restartCount = 0;
		const containerStatus = podStatus.containerStatuses.find(
			(status) => status.name === container.name,
		);
		if (containerStatus !== undefined) {
			restartCount = containerStatus.restartCount + 1;
		}

		const [containerConfig, cleanupAction, configErr] = this.generateContainerConfig(
			ctx,
			container,
			pod,
			restartCount,
			podIP,
			imageRef,
			podIPs,
			undefined,
			imageVolumes,
		);
		try {
			if (configErr || !containerConfig) {
				const message = configErr?.message ?? "failed to generate container config";
				await this.recordContainerEvent(
					ctx,
					pod,
					container,
					"",
					"Warning",
					"Failed",
					"Error: %v",
					message,
				);
				return [message, errCreateContainerConfig];
			}

			// Upstream calls setActuatedContainerResources here. The simulator does
			// not model allocation manager resource actuation (yet).
			const preCreateErr = this.internalLifecycle.preCreateContainer(
				pod,
				container,
				containerConfig,
			);
			if (preCreateErr) {
				await this.recordContainerEvent(
					ctx,
					pod,
					container,
					"",
					"Warning",
					"Failed",
					"Internal PreCreateContainer hook failed: %v",
					preCreateErr.message,
				);
				return [preCreateErr.message, errPreCreateHook];
			}

			const [containerID, createErr] = await this.runtimeService.createContainer(
				ctx,
				podSandboxID,
				containerConfig,
				podSandboxConfig,
			);
			if (createErr) {
				await this.recordContainerEvent(
					ctx,
					pod,
					container,
					containerID,
					"Warning",
					"Failed",
					"Error: %v",
					createErr.message,
				);
				return [createErr.message, errCreateContainer];
			}
			const preStartErr = this.internalLifecycle.preStartContainer(pod, container, containerID);
			if (preStartErr) {
				await this.recordContainerEvent(
					ctx,
					pod,
					container,
					containerID,
					"Warning",
					"Failed",
					"Internal PreStartContainer hook failed: %v",
					preStartErr.message,
				);
				return [preStartErr.message, errPreStartHook];
			}
			await this.recordContainerEvent(
				ctx,
				pod,
				container,
				containerID,
				"Normal",
				"Created",
				"Container created",
			);

			const startErr = await this.runtimeService.startContainer(ctx, containerID);
			if (startErr) {
				await this.recordContainerEvent(
					ctx,
					pod,
					container,
					containerID,
					"Warning",
					"Failed",
					"Error: %v",
					startErr.message,
				);
				return [startErr.message, errRunContainer];
			}
			await this.recordContainerEvent(
				ctx,
				pod,
				container,
				containerID,
				"Normal",
				"Started",
				"Container started",
			);

			if (container.lifecycle?.postStart) {
				const kubeContainerID = buildContainerID("simulator", containerID);
				const [msg, handlerErr] = await this.runner.run(
					ctx,
					kubeContainerID,
					pod,
					container,
					container.lifecycle.postStart,
				);
				if (handlerErr) {
					await this.recordContainerEvent(
						ctx,
						pod,
						container,
						kubeContainerID.id,
						"Warning",
						"FailedPostStartHook",
						"PostStartHook failed",
					);
					await this.runtimeService.stopContainer(ctx, containerID);
					return [msg, errPostStartHook];
				}
			}

			return ["", undefined];
		} finally {
			cleanupAction?.();
		}
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go executePreStopHook.
	async executePreStopHook(
		ctx: context.Context,
		pod: V1Pod,
		containerID: ContainerID,
		containerSpec: V1Container,
		gracePeriod: number,
	): Promise<number> {
		const preStop = containerSpec.lifecycle?.preStop;
		if (!preStop) {
			return 0;
		}
		const start = this.clock.nowMs();
		const done = new Channel<void>(1);
		void (async () => {
			let err: Error | undefined;
			try {
				[, err] = await this.runner.run(ctx, containerID, pod, containerSpec, preStop);
			} catch (error) {
				err = error instanceof Error ? error : new Error(String(error));
			}
			if (err) {
				await this.recordContainerEvent(
					ctx,
					pod,
					containerSpec,
					containerID.id,
					"Warning",
					"FailedPreStopHook",
					"PreStopHook failed",
				);
			}
			done.close();
		})();

		const selected = await select()
			.case(time.after(this.clock, gracePeriod * 1000), () => "timeout" as const)
			.case(done, () => "done" as const)
			.case(ctx.done(), () => "canceled" as const);
		if (selected === "canceled") {
			throw ctx.err() ?? context.Canceled;
		}
		return Math.floor((this.clock.nowMs() - start) / 1000);
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go generateContainerConfig.
	// Parity is very low here because upstream communicates a bunch with the OS
	// in this function and we have no analogues.
	private generateContainerConfig(
		ctx: context.Context,
		container: V1Container,
		pod: V1Pod,
		restartCount: number,
		podIP: string,
		imageRef: string,
		podIPs: string[],
		_nsTarget: unknown,
		imageVolumes: unknown,
	): [config: ContainerConfig | undefined, cleanupAction: CleanupAction, err: RuntimeError] {
		const [opts, cleanupAction, err] = this.runtimeHelper.generateRunContainerOptions(
			ctx,
			pod,
			container,
			podIP,
			podIPs,
			imageVolumes,
		);
		if (err || !opts) {
			return [undefined, cleanupAction, err];
		}
		return [
			{
				metadata: {
					name: container.name,
					attempt: restartCount,
				},
				image: {
					image: imageRef,
					userSpecifiedImage: container.image,
				},
				command: container.command,
				args: container.args,
				workingDir: container.workingDir,
				labels: newContainerLabels(container, pod),
				annotations: newContainerAnnotations(ctx, container, pod, restartCount, opts),
				env: Object.fromEntries((opts.envs ?? []).map((env) => [env.name, env.value])),
				ports: (container.ports ?? []).map((port) => ({
					name: port.name,
					containerPort: port.containerPort,
					protocol: runtimeProtocol(port.protocol),
				})),
			},
			cleanupAction,
			undefined,
		];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_sandbox.go generatePodSandboxConfig.
	generatePodSandboxConfig(
		ctx: context.Context,
		pod: V1Pod,
		attempt: number,
	): [config: PodSandboxConfig | undefined, err: RuntimeError] {
		const namespace = pod.metadata?.namespace ?? "default";
		const [dnsConfig, dnsErr] = this.runtimeHelper.getPodDNS(ctx, pod);
		if (dnsErr || !dnsConfig) {
			return [undefined, dnsErr];
		}
		let hostname: string | undefined;
		if (!isHostNetworkPod(pod)) {
			const [podHostname, podDomain, hostnameErr] =
				this.runtimeHelper.generatePodHostNameAndDomain(pod);
			if (hostnameErr) {
				return [undefined, hostnameErr];
			}
			const [podNodeName, nodeNameErr] = getNodenameForKernel(
				podHostname,
				podDomain,
				pod.spec?.setHostnameAsFQDN,
			);
			if (nodeNameErr) {
				return [undefined, nodeNameErr];
			}
			hostname = podNodeName;
		}
		return [
			{
				metadata: {
					uid: pod.metadata?.uid ?? `${namespace}/${pod.metadata?.name ?? ""}`,
					name: pod.metadata?.name ?? "",
					namespace,
					attempt,
				},
				hostname,
				dnsConfig,
				labels: pod.metadata?.labels,
				annotations: pod.metadata?.annotations,
				portMappings: podPortMappings(pod),
			},
			undefined,
		];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go computePodActions.
	computePodActions(
		ctx: context.Context,
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
		restartAllContainers: boolean,
	): PodActions {
		void ctx;
		const containers = pod.spec?.containers ?? [];
		const restartPolicy = pod.spec?.restartPolicy ?? "Always";
		const [createPodSandbox, attempt, sandboxID] = podSandboxChanged(pod, podStatus);
		const changes: PodActions = {
			createSandbox: createPodSandbox,
			killPod: createPodSandbox,
			sandboxID,
			attempt,
			containersToStart: [],
			containersToKill: new KeyFnMap((c) => c.toString()),
			containersToReset: [],
		};

		if (restartAllContainers) {
			const [sourceContainers, targetContainers] = this.getContainersToReset(containers, podStatus);
			changes.containersToReset.push(...targetContainers, ...sourceContainers);
			return changes;
		}

		if (createPodSandbox) {
			if (
				!shouldRestartOnFailure(pod) &&
				attempt !== 0 &&
				podStatus.containerStatuses.length !== 0
			) {
				changes.createSandbox = false;
				return changes;
			}
			const containersToStart: number[] = [];
			for (const [idx, c] of containers.entries()) {
				let runOnce = restartPolicy === "OnFailure";
				if (c.restartPolicy !== undefined) {
					runOnce = c.restartPolicy === "OnFailure";
				}
				if (runOnce && containerSucceeded(c, podStatus)) {
					continue;
				}
				if (
					c.restartPolicy !== undefined &&
					c.restartPolicy === "OnFailure" &&
					containerSucceeded(c, podStatus)
				) {
					continue;
				}
				containersToStart.push(idx);
			}

			if (containersToStart.length === 0) {
				const hasInitialized = hasAnyRegularContainerCreated(pod, podStatus);
				if (hasInitialized) {
					changes.createSandbox = false;
					return changes;
				}
			}

			changes.containersToStart = containersToStart;
			return changes;
		}

		let keepCount = 0;
		for (const [idx, container] of containers.entries()) {
			const containerStatus = findContainerStatusByName(podStatus, container.name);

			if (containerStatus !== undefined && containerStatus.state !== "Running") {
				this.internalLifecycle.postStopContainer(containerStatus.id.id);
			}

			if (containerStatus === undefined || containerStatus.state !== "Running") {
				if (shouldContainerBeRestarted(container, pod, podStatus)) {
					changes.containersToStart.push(idx);
					if (containerStatus !== undefined && containerStatus.state === "Unknown") {
						changes.containersToKill.set(containerStatus.id, {
							name: containerStatus.name,
							container,
							message: `Container is in "${containerStatus.state}" state, try killing it before restart`,
							reason: "Unknown",
						});
					}
				}
				continue;
			}

			let message = "";
			let reason: ContainerKillReason | undefined;
			let restart = shouldRestartOnFailure(pod);
			if (container.restartPolicy !== undefined) {
				restart = container.restartPolicy !== "Never";
			}

			const changed = containerChanged(container, containerStatus);
			if (changed) {
				message = `Container ${container.name} definition changed`;
				restart = true;
			} else if (this.livenessManager.get(containerStatus.id) === "failure") {
				message = `Container ${container.name} failed liveness probe`;
				reason = "LivenessProbe";
			} else if (this.startupManager.get(containerStatus.id) === "failure") {
				message = `Container ${container.name} failed startup probe`;
				reason = "StartupProbe";
			} else {
				keepCount++;
				continue;
			}

			if (restart) {
				message = `${message}, will be restarted`;
				changes.containersToStart.push(idx);
			}

			changes.containersToKill.set(containerStatus.id, {
				name: containerStatus.name,
				container,
				message,
				reason,
			});
		}

		if (keepCount === 0 && changes.containersToStart.length === 0) {
			changes.killPod = true;
		}
		return changes;
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go getContainersToReset.
	private getContainersToReset(
		containers: V1Container[],
		podStatus: PodRuntimeStatus,
	): [sources: ContainerToRemoveInfo[], targets: ContainerToRemoveInfo[]] {
		const sources: ContainerToRemoveInfo[] = [];
		const targets: ContainerToRemoveInfo[] = [];
		for (const c of containers) {
			for (const containerStatus of podStatus.containerStatuses) {
				if (containerStatus.name !== c.name) {
					continue;
				}
				const info: ContainerToRemoveInfo = {
					containerID: containerStatus.id,
					container: c,
					kill: false,
				};
				if (containerStatus.state === "Exited") {
					const rule = findMatchingContainerRestartRule(c, containerStatus.exitCode ?? 0);
					if (rule?.action === "RestartAllContainers") {
						sources.push(info);
					} else {
						targets.push(info);
					}
				} else {
					info.kill = true;
					targets.push(info);
				}
			}
		}
		return [sources, targets];
	}
}

type ContainerKillReason = "StartupProbe" | "LivenessProbe" | "Unknown";

interface ContainerToKillInfo {
	container: V1Container;
	name: string;
	message: string;
	reason?: ContainerKillReason;
}

interface ContainerToRemoveInfo {
	containerID: ContainerID;
	container: V1Container;
	kill: boolean;
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go podActions.
export interface PodActions {
	createSandbox: boolean;
	killPod: boolean;
	sandboxID: string;
	attempt: number;
	containersToStart: number[];
	containersToKill: KeyFnMap<ContainerID, ContainerToKillInfo>;
	containersToReset: ContainerToRemoveInfo[];
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go shouldRestartOnFailure.
function shouldRestartOnFailure(pod: V1Pod): boolean {
	return pod.spec?.restartPolicy !== "Never";
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go containerSucceeded.
function containerSucceeded(container: V1Container, podStatus: PodRuntimeStatus): boolean {
	const containerStatus = findContainerStatusByName(podStatus, container.name);
	if (!containerStatus) {
		return false;
	}
	return containerStatus.state === "Exited" && (containerStatus.exitCode ?? 0) === 0;
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go HasAnyRegularContainerCreated.
function hasAnyRegularContainerCreated(pod: V1Pod, podStatus: PodRuntimeStatus): boolean {
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

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go containerChanged.
function containerChanged(spec: V1Container, status: ContainerStatus): boolean {
	return status.hash !== hashContainer(spec);
}

function podPortMappings(pod: V1Pod): PortMapping[] | undefined {
	const portMappings = (pod.spec?.containers ?? []).flatMap((container) =>
		makePortMappings(container),
	);
	return portMappings.length > 0 ? portMappings : undefined;
}
