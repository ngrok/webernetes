import type { V1Container, V1Pod } from "../../../client";
import type { Clock } from "../../../clock";
import type { Backoff } from "../../../client-go/util/flowcontrol/backoff";
import { KeyFnMap } from "../../../collections";
import { Channel, select } from "../../../go/channel";
import * as context from "../../../go/context";
import * as time from "../../../go/time";
import type {
	ContainerConfig,
	ContainerStatus,
	ImageManagerService,
	PodRuntimeStatus,
	PodSandboxConfig,
	PodSandboxStatus,
	PortMapping,
	RuntimeService,
} from "../../cri";
import type {
	CheckpointContainerRequest,
	Container as CRIContainer,
	ContainerEventResponse,
	MetricDescriptor,
	PodSandbox,
	PodSandboxMetrics,
} from "../../cri/runtime/v1/api";
import { findMatchingContainerRestartRule } from "../../api/v1/pod/util";
import {
	buildContainerID,
	convertPodStatusToRunningPod,
	errPodNotFound,
	expandContainerCommandAndArgs,
	findContainerStatusByName,
	generateContainerRef,
	getContainerSpec,
	hashContainer,
	isHostNetworkPod,
	makePortMappings,
	runtimeProtocol,
	shouldContainerBeRestarted,
} from "../container";
import {
	newBackoffError,
	newSyncResult,
	PodSyncResult,
	type ContainerID,
	type GCPolicy,
	type Image,
	type ImageSpec,
	type ImageStats,
	type Pod as RuntimePod,
	type Runtime,
	type RuntimeStatus,
	type CommandRunner,
	type RuntimeHelper,
	type Status,
	type SyncResult,
	type SwapBehavior,
	type Version,
} from "../container";
import type { EventRecorder } from "../../events";
import type { ImageManager } from "../images";
import type { ResultsManager } from "../prober/results";
import type { InternalContainerLifecycle } from "../cm";
import type { HandlerRunner } from "../container";
import { failedCreatePodSandBox, failedStatusPodSandBox, sandboxChanged } from "../events";
import * as format from "../util/format";
import { getNodenameForKernel, podSandboxChanged } from "./util/util";
import {
	getTerminationMessage,
	hasAnyRegularContainerCreated,
	isNotFoundError,
	minimumGracePeriodInSeconds,
	setTerminationGracePeriod,
	containerFilter,
	sandboxFilter,
	type ContainerKillReason,
	type ListOptions,
	type StartSpec,
} from "./kuberuntime-container";
import { containerStatusByCreated, getBackoffKey, toKubeRuntimeStatus } from "./helpers";
import { toKubeContainerImageSpec, toRuntimeAPIImageSpec } from "./convert";
import type { TerminationOrdering } from "./kuberuntime-termination-order";
import { determinePodSandboxIPs } from "./kuberuntime-sandbox";
import { convertPodSysctlsVariableToDotsSeparator } from "../sysctl";
import {
	getContainerInfoFromAnnotations,
	getContainerInfoFromLabels,
	newContainerAnnotations,
	newContainerLabels,
	newPodAnnotations,
	newPodLabels,
} from "./labels";

type RuntimeError = Error | undefined;
type CleanupAction = (() => void) | undefined;

class RuntimeVersion implements Version {
	constructor(private readonly value: string) {}

	compare(other: string): [result: number, err: Error | undefined] {
		if (this.value === other) {
			return [0, undefined];
		}
		return [this.value < other ? -1 : 1, undefined];
	}

	toString(): string {
		return this.value;
	}
}

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

export interface KubeGenericRuntimeManagerOptions {
	ctx: context.Context;
	runtimeService: RuntimeService;
	imageService: ImageManagerService;
	runtimeHelper: RuntimeHelper;
	imagePuller: ImageManager;
	events: EventRecorder;
	internalLifecycle: InternalContainerLifecycle;
	livenessManager: ResultsManager;
	runner?: HandlerRunner;
	startupManager: ResultsManager;
	clock: Clock;
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.
export class KubeGenericRuntimeManager implements Runtime, CommandRunner {
	private readonly ctx: context.Context;
	private readonly runtimeService: RuntimeService;
	private readonly imageService: ImageManagerService;
	runtimeHelper: RuntimeHelper;
	private readonly imagePuller: ImageManager;
	private readonly events: EventRecorder;
	private readonly internalLifecycle: InternalContainerLifecycle;
	private readonly livenessManager: ResultsManager;
	private runner: HandlerRunner | undefined;
	private readonly startupManager: ResultsManager;
	private readonly clock: Clock;

	constructor(options: KubeGenericRuntimeManagerOptions) {
		this.ctx = options.ctx;
		this.runtimeService = options.runtimeService;
		this.imageService = options.imageService;
		this.runtimeHelper = options.runtimeHelper;
		this.imagePuller = options.imagePuller;
		this.events = options.events;
		this.internalLifecycle = options.internalLifecycle;
		this.livenessManager = options.livenessManager;
		this.runner = options.runner;
		this.startupManager = options.startupManager;
		this.clock = options.clock;
	}

	setHandlerRunner(runner: HandlerRunner): void {
		this.runner = runner;
	}

	private handlerRunner(): HandlerRunner {
		if (!this.runner) {
			throw new Error("handler runner is not configured");
		}
		return this.runner;
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.Type.
	type(): string {
		return "simulator";
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.Version.
	async version(
		ctx: context.Context,
	): Promise<[version: Version | undefined, err: Error | undefined]> {
		const [response, err] = await this.runtimeService.version(ctx, "0.1.0");
		if (err || !response) {
			return [undefined, err];
		}
		return [new RuntimeVersion(response.runtimeVersion), undefined];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.APIVersion.
	async apiVersion(): Promise<[version: Version | undefined, err: Error | undefined]> {
		const [response, err] = await this.runtimeService.version(this.ctx, "0.1.0");
		if (err || !response) {
			return [undefined, err];
		}
		return [new RuntimeVersion(response.runtimeApiVersion), undefined];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.Status.
	async status(
		ctx: context.Context,
	): Promise<[status: RuntimeStatus | undefined, err: Error | undefined]> {
		const [response, err] = await this.runtimeService.status(ctx, false);
		if (err) {
			return [undefined, err];
		}
		if (!response?.status) {
			return [undefined, new Error("runtime status is nil")];
		}
		return [
			toKubeRuntimeStatus(response.status, response.runtimeHandlers, response.features),
			undefined,
		];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.GetPods.
	async getPods(
		ctx: context.Context,
		all: boolean,
	): Promise<[pods: RuntimePod[], err: Error | undefined]> {
		const [pods, err] = await this.getPodsInternal(ctx, { onlyRunningReady: !all });
		if (err) {
			return [[], err];
		}
		const result = [...pods.values()];
		result.sort((left, right) => right.createdAt - left.createdAt);
		return [result, undefined];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.GetPod.
	async getPod(
		ctx: context.Context,
		podUid: string,
	): Promise<[pod: RuntimePod | undefined, err: Error | undefined]> {
		const [pods, err] = await this.getPodsInternal(ctx, { podUID: podUid });
		if (err) {
			return [undefined, err];
		}
		const pod = pods.get(podUid);
		if (!pod) {
			return [undefined, errPodNotFound];
		}
		return [pod, undefined];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.getPods.
	private async getPodsInternal(
		ctx: context.Context,
		opts: ListOptions,
	): Promise<[pods: Map<string, RuntimePod>, err: Error | undefined]> {
		const pods = new Map<string, RuntimePod>();
		const timestamp = this.clock.now();
		const [sandboxes, sandboxErr] = await this.getSandboxes(ctx, opts);
		if (sandboxErr) {
			return [pods, sandboxErr];
		}
		const sortedSandboxes = sandboxes.toSorted(
			(left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id),
		);
		for (const s of sortedSandboxes) {
			const podUID = s.metadata.uid;
			let pod = pods.get(podUID);
			if (!pod) {
				pod = {
					id: podUID,
					name: s.metadata.name,
					namespace: s.metadata.namespace,
					timestamp,
					createdAt: 0,
					containers: [],
					sandboxes: [],
				};
				pods.set(podUID, pod);
			}
			const [converted, convertErr] = this.sandboxToKubeContainer(s);
			if (convertErr || !converted) {
				continue;
			}
			pod.sandboxes.push(converted);
			pod.createdAt = s.createdAt;
		}

		const [containers, containerErr] = await this.getContainers(ctx, opts);
		if (containerErr) {
			return [pods, containerErr];
		}
		const sortedContainers = containers.toSorted(
			(left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id),
		);
		for (const c of sortedContainers) {
			const labelledInfo = getContainerInfoFromLabels(c.labels);
			let pod = pods.get(labelledInfo.podUID);
			if (!pod) {
				pod = {
					id: labelledInfo.podUID,
					name: labelledInfo.podName,
					namespace: labelledInfo.podNamespace,
					timestamp,
					createdAt: 0,
					containers: [],
					sandboxes: [],
				};
				pods.set(labelledInfo.podUID, pod);
			}
			const [converted, convertErr] = this.toKubeContainer(ctx, c);
			if (convertErr || !converted) {
				continue;
			}
			pod.containers.push(converted);
		}

		return [pods, undefined];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go kubeGenericRuntimeManager.getContainers.
	private async getContainers(
		ctx: context.Context,
		opts: ListOptions,
	): Promise<[containers: CRIContainer[], err: Error | undefined]> {
		return await this.runtimeService.listContainers(ctx, containerFilter(opts));
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go kubeGenericRuntimeManager.getSandboxes.
	private async getSandboxes(
		ctx: context.Context,
		opts: ListOptions,
	): Promise<[sandboxes: PodSandbox[], err: Error | undefined]> {
		return await this.runtimeService.listPodSandbox(ctx, sandboxFilter(opts));
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/helpers.go sandboxToKubeContainer.
	private sandboxToKubeContainer(
		sandbox: PodSandbox,
	): [container: RuntimePod["sandboxes"][number] | undefined, err: Error | undefined] {
		return [
			{
				id: buildContainerID(this.type(), sandbox.id),
				name: "",
				image: "",
				imageID: "",
				imageRef: "",
				imageRuntimeHandler: "",
				hash: 0,
				state: sandbox.state === "Ready" ? "Running" : "Exited",
				podSandboxID: sandbox.id,
				createdAt: sandbox.createdAt,
			},
			undefined,
		];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/helpers.go toKubeContainer.
	private toKubeContainer(
		ctx: context.Context,
		container: CRIContainer,
	): [container: RuntimePod["containers"][number] | undefined, err: Error | undefined] {
		const annotatedInfo = getContainerInfoFromAnnotations(ctx, container.annotations);
		return [
			{
				id: buildContainerID(this.type(), container.id),
				name: container.metadata.name,
				image: container.image.image,
				imageID: container.imageId,
				imageRef: container.imageRef,
				imageRuntimeHandler: container.image.runtimeHandler ?? "",
				hash: annotatedInfo.hash,
				state: container.state,
				podSandboxID: container.podSandboxId,
				createdAt: container.createdAt,
			},
			undefined,
		];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.SyncPod.
	async syncPod(
		ctx: context.Context,
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
		pullSecrets: unknown[],
		backOff: Backoff,
		restartAllContainers: boolean,
	): Promise<PodSyncResult> {
		const result = new PodSyncResult();
		const podContainerChanges = this.computePodActions(ctx, pod, podStatus, restartAllContainers);
		let podIPs = podStatus.ips;
		let podSandboxID = podContainerChanges.sandboxID;

		if (podContainerChanges.createSandbox) {
			if (podContainerChanges.sandboxID !== "") {
				await this.events.event(
					pod,
					"Normal",
					sandboxChanged,
					"Pod sandbox changed, it will be killed and re-created.",
				);
			}
		}

		if (podContainerChanges.killPod) {
			const killResult = await this.killPodWithSyncResult(
				ctx,
				pod,
				convertPodStatusToRunningPod(this.type(), podStatus),
				undefined,
			);
			result.addPodSyncResult(killResult);
			if (killResult.error()) {
				return result;
			}
		} else {
			for (const [containerID, containerInfo] of podContainerChanges.containersToKill) {
				const killContainerResult = newSyncResult("KillContainer", containerInfo.name);
				result.addSyncResult(killContainerResult);
				const killErr = await this.killContainer(
					ctx,
					pod,
					containerID,
					containerInfo.name,
					containerInfo.message,
					containerInfo.reason,
					undefined,
					undefined,
				);
				if (killErr) {
					killContainerResult.fail(killErr, killErr.message);
					return result;
				}
			}

			for (const containerInfo of podContainerChanges.containersToReset) {
				const removeContainerResult = newSyncResult(
					"RemoveContainer",
					containerInfo.container.name,
				);
				result.addSyncResult(removeContainerResult);
				if (containerInfo.kill) {
					const killErr = await this.killContainer(
						ctx,
						pod,
						containerInfo.containerID,
						containerInfo.container.name,
						"killing",
						"RestartAllContainers",
						0,
						undefined,
					);
					if (killErr) {
						removeContainerResult.fail(killErr, killErr.message);
						return result;
					}
				}
				const removeErr = await this.removeContainer(ctx, containerInfo.containerID.id, true);
				if (removeErr) {
					removeContainerResult.fail(removeErr, removeErr.message);
					return result;
				}
			}
		}

		if (podContainerChanges.createSandbox) {
			const createSandboxResult = newSyncResult("CreatePodSandbox", format.pod(pod));
			result.addSyncResult(createSandboxResult);
			convertPodSysctlsVariableToDotsSeparator(pod.spec?.securityContext);
			const [createdPodSandboxID, msg, createSandboxErr] = await this.createPodSandbox(
				ctx,
				pod,
				podContainerChanges.attempt,
			);
			if (createSandboxErr) {
				createSandboxResult.fail(createSandboxErr, msg);
				await this.events.eventf(
					pod,
					"Warning",
					failedCreatePodSandBox,
					"Failed to create pod sandbox: %v",
					createSandboxErr.message,
				);
				return result;
			}
			podSandboxID = createdPodSandboxID;

			const [resp, sandboxStatusErr] = await this.runtimeService.podSandboxStatus(
				ctx,
				podSandboxID,
				false,
			);
			if (sandboxStatusErr) {
				result.fail(sandboxStatusErr);
				await this.events.eventf(
					pod,
					"Warning",
					failedStatusPodSandBox,
					"Unable to get pod sandbox status: %v",
					sandboxStatusErr.message,
				);
				return result;
			}
			if (!resp?.status) {
				result.fail(new Error("pod sandbox status is nil"));
				return result;
			}
			if (!isHostNetworkPod(pod)) {
				podIPs = determinePodSandboxIPs(
					ctx,
					pod.metadata?.namespace ?? "default",
					pod.metadata?.name ?? "",
					resp.status,
				);
				podStatus.ips = podIPs;
			}
			const callbackErr = this.runtimeHelper.onPodSandboxReady(ctx, pod);
			if (callbackErr) {
				void callbackErr;
			}
		}

		let podIP = "";
		if (podIPs.length !== 0) {
			podIP = podIPs[0];
		}

		const [sandboxConfig, sandboxConfigErr] = this.generatePodSandboxConfig(
			ctx,
			pod,
			podContainerChanges.attempt,
		);
		if (sandboxConfigErr || !sandboxConfig) {
			result.fail(sandboxConfigErr ?? new Error("failed to generate pod sandbox config"));
			return result;
		}

		for (const idx of podContainerChanges.containersToStart) {
			const container = pod.spec?.containers?.[idx];
			if (!container) {
				continue;
			}
			const startContainerResult = newSyncResult("StartContainer", container.name);
			result.addSyncResult(startContainerResult);
			const [isInBackOff, backOffMessage, backOffErr] = await this.doBackOff(
				ctx,
				pod,
				container,
				podStatus,
				backOff,
			);
			if (isInBackOff) {
				startContainerResult.fail(backOffErr ?? new Error(backOffMessage), backOffMessage);
				return result;
			}
			const [message, err] = await this.startContainer(
				ctx,
				podSandboxID,
				sandboxConfig,
				{ container },
				pod,
				podStatus,
				pullSecrets,
				podIP,
				podIPs,
				undefined,
			);
			if (err) {
				startContainerResult.fail(err, message || err.message);
				return result;
			}
		}

		return result;
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.doBackOff.
	private async doBackOff(
		ctx: context.Context,
		pod: V1Pod,
		container: V1Container,
		podStatus: PodRuntimeStatus,
		backOff: Backoff,
	): Promise<[isInBackOff: boolean, msg: string, err: Error | undefined]> {
		const containerStatus = podStatus.containerStatuses.find(
			(status) => status.name === container.name && status.state === "Exited",
		);
		if (!containerStatus) {
			return [false, "", undefined];
		}

		const finishedAt = new Date(containerStatus.finishedAt ?? 0);
		const key = getBackoffKey(pod, container);
		if (backOff.isInBackOffSince(key, finishedAt)) {
			await this.recordContainerEvent(
				ctx,
				pod,
				container,
				"",
				"Warning",
				"BackOff",
				"Back-off restarting failed container %s in pod %s",
				container.name,
				format.pod(pod),
			);
			const backoff = backOff.get(key);
			const err = new Error(
				`back-off ${backoff}ms restarting failed container=${container.name} pod=${format.pod(pod)}`,
			);
			return [
				true,
				err.message,
				newBackoffError(new Error("CrashLoopBackOff"), new Date(finishedAt.getTime() + backoff)),
			];
		}

		backOff.next(key, finishedAt);
		return [false, "", undefined];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go killContainer.
	private async killContainer(
		ctx: context.Context,
		pod: V1Pod | undefined,
		containerID: ContainerID,
		containerName: string,
		message: string,
		reason: ContainerKillReason | undefined,
		gracePeriodOverride: number | undefined,
		ordering: TerminationOrdering | undefined,
	): Promise<Error | undefined> {
		let containerSpec: V1Container | undefined;
		if (pod !== undefined) {
			containerSpec = getContainerSpec(pod, containerName);
			if (containerSpec === undefined) {
				return new Error(
					`failed to get containerSpec "${containerName}" (id="${containerID.toString()}") in pod "${format.pod(pod)}" when killing container for reason "${message}"`,
				);
			}
		} else {
			const [restoredPod, restoredContainer, err] = await this.restoreSpecsFromContainerLabels(
				ctx,
				containerID,
			);
			if (err) {
				return err;
			}
			pod = restoredPod;
			containerSpec = restoredContainer;
		}

		let gracePeriod = setTerminationGracePeriod(
			ctx,
			pod,
			containerSpec,
			containerName,
			containerID,
			reason ?? "Unknown",
		);
		if (message.length === 0) {
			message = `Stopping container ${containerSpec.name}`;
		}
		await this.recordContainerEvent(
			ctx,
			pod,
			containerSpec,
			containerID.id,
			"Normal",
			"Killing",
			"%v",
			message,
		);

		if (gracePeriodOverride !== undefined) {
			gracePeriod = gracePeriodOverride;
		}

		if (containerSpec.lifecycle?.preStop && gracePeriod > 0) {
			gracePeriod -= await this.executePreStopHook(
				ctx,
				pod,
				containerID,
				containerSpec,
				gracePeriod,
			);
		}

		if (ordering !== undefined && gracePeriod > 0) {
			gracePeriod -= Math.floor(await ordering.waitForTurn(containerName, gracePeriod));
		}

		if (gracePeriod < minimumGracePeriodInSeconds) {
			gracePeriod = minimumGracePeriodInSeconds;
		}

		const err = await this.runtimeService.stopContainer(ctx, containerID.id, gracePeriod);
		if (err && !isNotFoundError(err)) {
			return err;
		}
		if (ordering !== undefined) {
			ordering.containerTerminated(containerName);
		}
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go restoreSpecsFromContainerLabels.
	private async restoreSpecsFromContainerLabels(
		ctx: context.Context,
		containerID: ContainerID,
	): Promise<[pod: V1Pod, container: V1Container, err: Error | undefined]> {
		const [resp, err] = await this.runtimeService.containerStatus(ctx, containerID.id, false);
		if (err) {
			return [{}, { name: "" }, err];
		}
		const s = resp?.status;
		if (s === undefined) {
			return [{}, { name: "" }, new Error("container status is nil")];
		}

		const l = getContainerInfoFromLabels(s.labels);
		const a = getContainerInfoFromAnnotations(ctx, s.annotations);
		const pod: V1Pod = {
			metadata: {
				uid: l.podUID,
				name: l.podName,
				namespace: l.podNamespace,
				deletionGracePeriodSeconds: a.podDeletionGracePeriod,
			},
			spec: {
				terminationGracePeriodSeconds: a.podTerminationGracePeriod,
				containers: [],
			},
		};
		const container: V1Container = {
			name: l.containerName,
			ports: a.containerPorts,
			terminationMessagePath: a.terminationMessagePath,
		};
		if (a.preStopHandler !== undefined) {
			container.lifecycle = {
				preStop: a.preStopHandler,
			};
		}
		return [pod, container, undefined];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go killPodWithSyncResult.
	private async killPodWithSyncResult(
		ctx: context.Context,
		pod: V1Pod | undefined,
		runningPod: RuntimePod,
		gracePeriodOverride: number | undefined,
	): Promise<PodSyncResult> {
		const result = new PodSyncResult();
		const killContainerResults = await this.killContainersWithSyncResult(
			ctx,
			pod,
			runningPod,
			gracePeriodOverride,
		);
		for (const containerResult of killContainerResults) {
			result.addSyncResult(containerResult);
		}

		const sandboxResult = newSyncResult("KillPodSandbox", runningPod.id);
		result.addSyncResult(sandboxResult);
		for (const sandbox of runningPod.sandboxes) {
			const stopErr = await this.runtimeService.stopPodSandbox(ctx, sandbox.id.id);
			if (stopErr && !isNotFoundError(stopErr)) {
				sandboxResult.fail(stopErr, stopErr.message);
			}
		}
		return result;
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go killContainersWithSyncResult.
	private async killContainersWithSyncResult(
		ctx: context.Context,
		pod: V1Pod | undefined,
		runningPod: RuntimePod,
		gracePeriodOverride: number | undefined,
	): Promise<SyncResult[]> {
		// Upstream creates termination ordering for restartable init containers.
		// The simulator does not model init containers yet, so no ordering is needed.
		let termOrdering: TerminationOrdering | undefined = undefined;

		return await Promise.all(
			runningPod.containers.map(async (container) => {
				const killContainerResult = newSyncResult("KillContainer", container.name);
				const err = await this.killContainer(
					ctx,
					pod,
					container.id,
					container.name,
					"",
					"Unknown",
					gracePeriodOverride,
					termOrdering,
				);
				if (err) {
					killContainerResult.fail(err, err.message);
				}
				return killContainerResult;
			}),
		);
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.KillPod.
	async killPod(
		ctx: context.Context,
		pod: V1Pod | undefined,
		runningPod: RuntimePod,
		gracePeriodOverride: number | undefined,
	): Promise<Error | undefined> {
		const result = await this.killPodWithSyncResult(ctx, pod, runningPod, gracePeriodOverride);
		return result.error();
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.GetPodStatus.
	async getPodStatus(
		ctx: context.Context,
		pod: RuntimePod,
	): Promise<[podStatus: PodRuntimeStatus | undefined, err: Error | undefined]> {
		const podSandboxIDs = new Array<string>(pod.sandboxes.length);
		for (const [i, sandbox] of pod.sandboxes.entries()) {
			podSandboxIDs[i] = sandbox.id.id;
		}

		const sandboxStatuses: PodSandboxStatus[] = [];
		let containerStatuses: ContainerStatus[] = [];
		let activeContainerStatuses: ContainerStatus[] = [];
		let timestamp = pod.timestamp;

		let podIPs: string[] = [];
		let activePodSandboxID = "";
		for (const [idx, podSandboxID] of podSandboxIDs.entries()) {
			const [response, err] = await this.runtimeService.podSandboxStatus(ctx, podSandboxID, false);
			if (err) {
				if (isNotFoundError(err)) {
					continue;
				}
				return [undefined, err];
			}
			if (!response?.status) {
				return [undefined, new Error("pod sandbox status is nil")];
			}
			sandboxStatuses.push(response.status);
			if (idx === 0 && response.status.state === "Ready") {
				podIPs = determinePodSandboxIPs(ctx, pod.namespace, pod.name, response.status);
				activePodSandboxID = podSandboxID;
			}
		}

		// Evented PLEG is not modeled; always inspect containers directly.
		const [statuses, activeStatuses, statusErr] = await this.getPodContainerStatuses(
			ctx,
			pod,
			activePodSandboxID,
		);
		if (statusErr) {
			return [undefined, statusErr];
		}
		containerStatuses = statuses;
		activeContainerStatuses = activeStatuses;

		return [
			{
				id: pod.id,
				name: pod.name,
				namespace: pod.namespace,
				ips: podIPs,
				sandboxStatuses,
				containerStatuses,
				activeContainerStatuses,
				timestamp,
			},
			undefined,
		];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go getPodContainerStatuses.
	private async getPodContainerStatuses(
		ctx: context.Context,
		pod: RuntimePod,
		activePodSandboxID: string,
	): Promise<
		[
			statuses: ContainerStatus[],
			activeContainerStatuses: ContainerStatus[],
			err: Error | undefined,
		]
	> {
		const statuses: ContainerStatus[] = [];
		const activeContainerStatuses: ContainerStatus[] = [];
		for (const c of pod.containers) {
			const [resp, err] = await this.runtimeService.containerStatus(ctx, c.id.id, false);
			if (err) {
				if (isNotFoundError(err)) {
					continue;
				}
				return [[], [], err];
			}
			if (!resp?.status) {
				return [[], [], new Error("container status is nil")];
			}
			const cStatus = this.convertToKubeContainerStatus(ctx, pod.id, resp.status);
			statuses.push(cStatus);
			if (c.podSandboxID === activePodSandboxID) {
				activeContainerStatuses.push(cStatus);
			}
		}

		statuses.sort(containerStatusByCreated);
		activeContainerStatuses.sort(containerStatusByCreated);
		return [statuses, activeContainerStatuses, undefined];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go convertToKubeContainerStatus.
	private convertToKubeContainerStatus(
		ctx: context.Context,
		podUID: string,
		status: ContainerStatus,
	): ContainerStatus {
		const cStatus = this.toKubeContainerStatus(ctx, podUID, status, this.type());
		if (status.state === "Exited") {
			const annotatedInfo = getContainerInfoFromAnnotations(ctx, status.annotations);
			const fallbackToLogs =
				annotatedInfo.terminationMessagePolicy === "FallbackToLogsOnError" &&
				(cStatus.exitCode ?? 0) !== 0 &&
				cStatus.reason !== "ContainerCannotRun";
			let [tMessage, checkLogs] = getTerminationMessage(
				status,
				annotatedInfo.terminationMessagePath,
				fallbackToLogs,
			);
			if (checkLogs) {
				tMessage = this.readLastStringFromContainerLogs(ctx, "");
			}
			if (tMessage.length !== 0) {
				if ((cStatus.message ?? "").length !== 0) {
					cStatus.message = `${cStatus.message}: `;
				}
				cStatus.message = `${cStatus.message ?? ""}${tMessage}`;
			}
		}
		return cStatus;
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go toKubeContainerStatus.
	private toKubeContainerStatus(
		ctx: context.Context,
		_podUID: string,
		status: ContainerStatus,
		runtimeName: string,
	): ContainerStatus {
		const annotatedInfo = getContainerInfoFromAnnotations(ctx, status.annotations);
		const labeledInfo = getContainerInfoFromLabels(status.labels);
		const imageID = status.imageRef;
		const cStatus: ContainerStatus = {
			id: buildContainerID(runtimeName, status.id.id),
			name: labeledInfo.containerName || status.name,
			imageRef: status.imageRef,
			imageRuntimeHandler: status.imageRuntimeHandler,
			hash: annotatedInfo.hash || status.hash,
			state: status.state,
			restartCount: annotatedInfo.restartCount,
			createdAt: status.createdAt,
			labels: { ...status.labels },
			annotations: { ...status.annotations },
			ready: status.ready,
		};
		void imageID;
		if (status.state !== "Created") {
			cStatus.startedAt = status.startedAt;
		}
		if (status.state === "Exited") {
			cStatus.reason = status.reason;
			cStatus.message = status.message;
			cStatus.exitCode = status.exitCode;
			cStatus.finishedAt = status.finishedAt;
		}
		return cStatus;
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go readLastStringFromContainerLogs.
	private readLastStringFromContainerLogs(_ctx: context.Context, _path: string): string {
		// The simulator does not model CRI log files.
		return "";
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go kubeGenericRuntimeManager.DeleteContainer.
	async deleteContainer(
		ctx: context.Context,
		containerID: ContainerID,
	): Promise<Error | undefined> {
		return await this.removeContainer(ctx, containerID.id, false);
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go removeContainer.
	private async removeContainer(
		ctx: context.Context,
		containerID: string,
		keepLogs: boolean,
	): Promise<Error | undefined> {
		const postStopErr = this.internalLifecycle.postStopContainer(containerID);
		if (postStopErr) {
			return postStopErr;
		}
		if (!keepLogs) {
			const removeLogErr = await this.removeContainerLog(ctx, containerID);
			if (removeLogErr) {
				return removeLogErr;
			}
		}
		return await this.runtimeService.removeContainer(ctx, containerID);
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go removeContainerLog.
	private async removeContainerLog(
		ctx: context.Context,
		containerID: string,
	): Promise<Error | undefined> {
		void ctx;
		void containerID;
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go kubeGenericRuntimeManager.RunInContainer.
	async runInContainer(
		ctx: context.Context,
		containerID: ContainerID,
		cmd: string[],
		timeoutSeconds?: number,
	): Promise<[output: string, err: Error | undefined]> {
		const [response, err] = await this.runtimeService.execSync(
			ctx,
			containerID.id,
			cmd,
			timeoutSeconds,
		);
		if (err) {
			return ["", err];
		}
		if (!response) {
			return ["", new Error("execSync returned no response")];
		}
		const output = response.stdout + response.stderr;
		if (response.exitCode !== 0) {
			return [output, new Error(`command terminated with exit code ${response.exitCode}`)];
		}
		return [output, undefined];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_image.go kubeGenericRuntimeManager.PullImage.
	async pullImage(
		ctx: context.Context,
		image: ImageSpec,
		credentials: unknown[],
		podSandboxConfig: PodSandboxConfig,
	): Promise<[imageRef: string, credentialsUsed: unknown | undefined, err: Error | undefined]> {
		const img = image.image;
		const imgSpec = toRuntimeAPIImageSpec(image);

		if (credentials.length === 0) {
			const [imageRef, err] = await this.imageService.pullImage(ctx, imgSpec, [], podSandboxConfig);
			if (err) {
				return ["", undefined, err];
			}
			return [imageRef, undefined, undefined];
		}

		return [
			"",
			undefined,
			new Error(`credentialed image pulls are not supported for image "${img}"`),
		];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_image.go kubeGenericRuntimeManager.GetImageRef.
	async getImageRef(
		ctx: context.Context,
		image: ImageSpec,
	): Promise<[imageRef: string, err: Error | undefined]> {
		const [resp, err] = await this.imageService.imageStatus(
			ctx,
			toRuntimeAPIImageSpec(image),
			false,
		);
		if (err) {
			return ["", err];
		}
		if (resp?.image === undefined) {
			return ["", undefined];
		}
		return [resp.image.id, undefined];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_image.go kubeGenericRuntimeManager.ListImages.
	async listImages(ctx: context.Context): Promise<[images: Image[], err: Error | undefined]> {
		const [allImages, err] = await this.imageService.listImages(ctx);
		if (err) {
			return [[], err];
		}
		const images: Image[] = [];
		for (const img of allImages) {
			images.push({
				id: img.id,
				size: img.size,
				repoTags: img.repoTags,
				repoDigests: img.repoDigests,
				spec: toKubeContainerImageSpec(img),
				pinned: img.pinned,
			});
		}
		return [images, undefined];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_image.go kubeGenericRuntimeManager.RemoveImage.
	async removeImage(ctx: context.Context, image: ImageSpec): Promise<Error | undefined> {
		return await this.imageService.removeImage(ctx, { image: image.image });
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_image.go kubeGenericRuntimeManager.ImageStats.
	async imageStats(
		ctx: context.Context,
	): Promise<[imageStats: ImageStats | undefined, err: Error | undefined]> {
		const [allImages, err] = await this.imageService.listImages(ctx);
		if (err) {
			return [undefined, err];
		}
		const stats: ImageStats = { totalStorageBytes: 0 };
		for (const img of allImages) {
			stats.totalStorageBytes += img.size;
		}
		return [stats, undefined];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_image.go kubeGenericRuntimeManager.ImageFsInfo.
	async imageFsInfo(ctx: context.Context): Promise<[imageFsInfo: unknown, err: Error | undefined]> {
		const [allImages, err] = await this.imageService.imageFsInfo(ctx);
		if (err) {
			return [undefined, err];
		}
		return [allImages, undefined];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_image.go kubeGenericRuntimeManager.GetImageSize.
	async getImageSize(
		ctx: context.Context,
		image: ImageSpec,
	): Promise<[imageSize: number, err: Error | undefined]> {
		const [resp, err] = await this.imageService.imageStatus(
			ctx,
			toRuntimeAPIImageSpec(image),
			false,
		);
		if (err) {
			return [0, err];
		}
		if (resp?.image === undefined) {
			return [0, undefined];
		}
		return [resp.image.size, undefined];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.GarbageCollect.
	async garbageCollect(
		_ctx: context.Context,
		_gcPolicy: GCPolicy,
		_allSourcesReady: boolean,
		_evictNonDeletedPods: boolean,
	): Promise<Error | undefined> {
		// TODO(samwho): implement this.
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.UpdatePodCIDR.
	async updatePodCIDR(ctx: context.Context, podCIDR: string): Promise<Error | undefined> {
		return await this.runtimeService.updateRuntimeConfig(ctx, {
			runtimeConfig: {
				networkConfig: {
					podCidr: podCIDR,
				},
			},
		});
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.CheckpointContainer.
	async checkpointContainer(
		ctx: context.Context,
		options: CheckpointContainerRequest,
	): Promise<Error | undefined> {
		return await this.runtimeService.checkpointContainer(ctx, options);
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.GeneratePodStatus.
	generatePodStatus(event: ContainerEventResponse): PodRuntimeStatus | undefined {
		const ctx = context.background();
		const podUID = event.podSandboxStatus.metadata.uid;
		const podIPs = determinePodSandboxIPs(
			ctx,
			event.podSandboxStatus.metadata.namespace,
			event.podSandboxStatus.metadata.name,
			event.podSandboxStatus,
		);

		const kubeContainerStatuses: ContainerStatus[] = [];
		for (const status of event.containersStatuses) {
			kubeContainerStatuses.push(this.convertToKubeContainerStatus(ctx, podUID, status));
		}

		kubeContainerStatuses.sort(containerStatusByCreated);

		return {
			id: event.podSandboxStatus.metadata.uid,
			name: event.podSandboxStatus.metadata.name,
			namespace: event.podSandboxStatus.metadata.namespace,
			ips: podIPs,
			sandboxStatuses: [event.podSandboxStatus],
			containerStatuses: kubeContainerStatuses,
			timestamp: this.clock.now(),
		};
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.ListMetricDescriptors.
	async listMetricDescriptors(
		ctx: context.Context,
	): Promise<[descriptors: MetricDescriptor[], err: Error | undefined]> {
		return await this.runtimeService.listMetricDescriptors(ctx);
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.ListPodSandboxMetrics.
	async listPodSandboxMetrics(
		ctx: context.Context,
	): Promise<[metrics: PodSandboxMetrics[], err: Error | undefined]> {
		return await this.runtimeService.listPodSandboxMetrics(ctx);
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.GetContainerStatus.
	async getContainerStatus(
		ctx: context.Context,
		_podUid: string,
		id: ContainerID,
	): Promise<[status: Status | undefined, err: Error | undefined]> {
		const [response, err] = await this.runtimeService.containerStatus(ctx, id.id, false);
		if (err) {
			return [undefined, new Error(`runtime container status: ${err.message}`, { cause: err })];
		}
		if (!response?.status) {
			return [undefined, new Error("container status is nil")];
		}
		return [response.status, undefined];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container_unsupported.go kubeGenericRuntimeManager.GetContainerSwapBehavior.
	getContainerSwapBehavior(_pod: V1Pod, _container: V1Container): SwapBehavior {
		return "NoSwap";
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.IsPodResizeInProgress.
	isPodResizeInProgress(_allocatedPod: V1Pod, _podStatus: PodRuntimeStatus): boolean {
		return false;
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go kubeGenericRuntimeManager.UpdateActuatedPodLevelResources.
	async updateActuatedPodLevelResources(_actuatedPod: V1Pod): Promise<Error | undefined> {
		return undefined;
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
				const [msg, handlerErr] = await this.handlerRunner().run(
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
				[, err] = await this.handlerRunner().run(ctx, containerID, pod, containerSpec, preStop);
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
	generateContainerConfig(
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
		const [command, args] = expandContainerCommandAndArgs(container, opts.envs ?? []);
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
				command,
				args,
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

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_sandbox.go createPodSandbox.
	private async createPodSandbox(
		ctx: context.Context,
		pod: V1Pod,
		attempt: number,
	): Promise<[podSandboxID: string, message: string, err: RuntimeError]> {
		const [podSandboxConfig, err] = this.generatePodSandboxConfig(ctx, pod, attempt);
		if (err || !podSandboxConfig) {
			const message = `Failed to generate sandbox config for pod "${format.pod(pod)}": ${err?.message ?? "failed to generate pod sandbox config"}`;
			return ["", message, err ?? new Error("failed to generate pod sandbox config")];
		}

		const runtimeHandler = "";
		const [podSandboxID, runErr] = await this.runtimeService.runPodSandbox(
			ctx,
			podSandboxConfig,
			runtimeHandler,
		);
		if (runErr) {
			const message = `Failed to create sandbox for pod "${format.pod(pod)}": ${runErr.message}`;
			return ["", message, runErr];
		}
		return [podSandboxID, "", undefined];
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
				labels: newPodLabels(pod),
				annotations: newPodAnnotations(pod),
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

			if (containerChanged(container, containerStatus)[2]) {
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

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager.go containerChanged.
function containerChanged(
	container: V1Container,
	containerStatus: ContainerStatus,
): [expectedHash: number, containerHash: number, changed: boolean] {
	const expectedHash = hashContainer(container);
	return [expectedHash, containerStatus.hash, containerStatus.hash !== expectedHash];
}

function podPortMappings(pod: V1Pod): PortMapping[] | undefined {
	const portMappings = (pod.spec?.containers ?? []).flatMap((container) =>
		makePortMappings(container),
	);
	return portMappings.length > 0 ? portMappings : undefined;
}
