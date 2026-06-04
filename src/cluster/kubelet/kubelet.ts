import type { V1Container, V1ContainerStatus, V1Pod, V1PodStatus, V1Service } from "../../client";
import { Channel, select, type ReadOnlyChannel } from "../../go/channel";
import * as context from "../../go/context";
import { parseIP } from "../../go/net";
import * as time from "../../go/time";
import type { Backoff } from "../../client-go/util/flowcontrol/backoff";
import { newBackOff } from "../../client-go/util/flowcontrol/backoff";
import type { DnsConfig, ExecResult, ImageManagerService, RuntimeService } from "../cri";
import {
	allContainersCouldRestart,
	containerShouldRestart,
	isPodPhaseTerminal,
} from "../api/v1/pod/util";
import {
	convertPodStatusToRunningPod,
	isHostNetworkPod,
	newRuntimeCache,
	PodStatusCache,
	shouldAllContainersRestart,
	toAPIPod,
} from "./container";
import type {
	CommandRunner,
	EnvVar,
	ImageService,
	Pod as RuntimePod,
	PodStatus as PodRuntimeStatus,
	Runtime as KubeletRuntime,
	RuntimeCache,
	Status as ContainerStatus,
} from "./container";
import type { RunContainerOptions, RuntimeHelper } from "./container";
import { PodManager } from "./pod";
import { ProbeManagerImpl, ResultsManager } from "./prober";
import type { ProbeManager, ProbeUpdate } from "./prober";
import { PodWorkersImpl, type PodWorkers, type SyncPodResult } from "./pod-workers";
import type { EventRecorder } from "../../client-go/tools/record/event";
import { StatusManager } from "./status";
import { ContainerDied, ContainerRemoved, GenericPLEG, type PodLifecycleEvent } from "./pleg";
import { networkNotReadyErrorMsg } from "./errors";
import * as podutil from "../api/v1/pod/util";
import { getPodQOS } from "../apis/core/v1/helper/qos/qos";
import { BasicWorkQueue } from "./util/queue/work-queue";
import type { WorkQueue } from "./util/queue/work-queue";
import { apiserverSource, isStaticPod, type PodUpdate, type SyncPodType } from "./types/pod-update";
import * as kubetypes from "./types/pod-status";
import { KubeGenericRuntimeManager } from "./kuberuntime";
import { newFakeInternalContainerLifecycle } from "./cm";
import { newHandlerRunner } from "./lifecycle";
import { KubeletImageManager } from "./images";
import { getPhase } from "./kubelet-pods";
import { newActiveDeadlineHandler } from "./active-deadline";
import {
	PodSyncHandlers,
	PodSyncLoopHandlers,
	type PodSyncHandler,
	type PodSyncLoopHandler,
} from "./lifecycle";
import {
	generateAllContainersRestartingCondition,
	generateContainersReadyCondition,
	generatePodInitializedCondition,
	generatePodReadyCondition,
	generatePodReadyToStartContainersCondition,
} from "./status";
import {
	newPodConfig,
	newSourcesReady,
	newSourceApiserver,
	PodListWatchClient,
	type PodConfig,
	type PodStartupSLIObserver,
	type SourcesReady,
} from "./config";
import { Configurer } from "./network/dns";
import { newReasonCache } from "./reason-cache";
import { newRuntimeState, type RuntimeState } from "./runtime";
import { getContainersToDeleteInPod } from "./pod-container-deletor";
import type { KubeletConfiguration } from "./apis/config";
import type { KubeClient } from "../cluster";
import type { ClusterNetwork } from "../cni";
import type { Clock } from "../../clock";
import {
	isDNS1123Label,
	isDNS1123Subdomain,
} from "../../apimachinery/pkg/util/validation/validation";

// Models kubernetes/pkg/kubelet/kubelet.go backOffPeriod.
const backOffPeriodMs = 10 * 1000;
// Models kubernetes/pkg/kubelet/kubelet.go MaxImageBackOff.
const maxImageBackOffMs = 300 * 1000;
// Models kubernetes/pkg/kubelet/kubelet.go imageBackOffPeriod.
const imageBackOffPeriodMs = 10 * 1000;
// Models kubernetes/pkg/kubelet/kubelet.go syncLoop's one-second syncTicker.
const syncTickerPeriodMs = 1000;
// Models kubernetes/pkg/kubelet/kubelet.go housekeepingPeriod.
const housekeepingPeriodMs = 2 * 1000;
// Models kubernetes/pkg/kubelet/kubelet.go housekeepingWarningDuration.
const housekeepingWarningDurationMs = 1000;
// Models kubernetes/pkg/kubelet/kubelet.go runtimeCacheRefreshPeriod.
const runtimeCacheRefreshPeriodMs = housekeepingPeriodMs + housekeepingWarningDurationMs;
// Models kubernetes/pkg/kubelet/kubelet.go maxWaitForContainerRuntime.
const maxWaitForContainerRuntimeMs = 30 * 1000;
// Models kubernetes/pkg/kubelet/kubelet.go syncLoop runtime readiness backoff base.
const syncLoopRuntimeBackoffBaseMs = 100;
// Models kubernetes/pkg/kubelet/kubelet.go syncLoop runtime readiness backoff max.
const syncLoopRuntimeBackoffMaxMs = 5 * 1000;
// Models kubernetes/pkg/kubelet/kubelet.go syncLoop runtime readiness backoff factor.
const syncLoopRuntimeBackoffFactor = 2;
// Models kubernetes/pkg/kubelet/kubelet_pods.go truncatePodHostnameIfNeeded hostnameMaxLen.
const hostnameMaxLen = 63;

function isIPv4(ip: number[] | undefined): boolean {
	if (!ip || ip.length !== 16) {
		return false;
	}
	for (let i = 0; i < 10; i++) {
		if (ip[i] !== 0) {
			return false;
		}
	}
	return ip[10] === 0xff && ip[11] === 0xff;
}

function isIPv6(ip: number[] | undefined): boolean {
	return ip !== undefined && ip.length === 16 && !isIPv4(ip);
}

function formatIP(ip: number[]): string {
	if (isIPv4(ip)) {
		return `${ip[12]}.${ip[13]}.${ip[14]}.${ip[15]}`;
	}

	const groups: number[] = [];
	for (let i = 0; i < ip.length; i += 2) {
		groups.push((ip[i] << 8) | ip[i + 1]);
	}

	let bestStart = -1;
	let bestLength = 0;
	for (let i = 0; i < groups.length; ) {
		if (groups[i] !== 0) {
			i++;
			continue;
		}
		let j = i;
		while (j < groups.length && groups[j] === 0) {
			j++;
		}
		if (j - i > bestLength && j - i >= 2) {
			bestStart = i;
			bestLength = j - i;
		}
		i = j;
	}

	if (bestStart < 0) {
		return groups.map((group) => group.toString(16)).join(":");
	}

	const before = groups.slice(0, bestStart).map((group) => group.toString(16));
	const after = groups.slice(bestStart + bestLength).map((group) => group.toString(16));
	if (before.length === 0 && after.length === 0) {
		return "::";
	}
	if (before.length === 0) {
		return `::${after.join(":")}`;
	}
	if (after.length === 0) {
		return `${before.join(":")}::`;
	}
	return `${before.join(":")}::${after.join(":")}`;
}

// Models kubernetes/pkg/kubelet/kubelet_pods.go truncatePodHostnameIfNeeded.
function truncatePodHostnameIfNeeded(
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

// Models kubernetes/pkg/kubelet/kubelet.go preserveDataFromBeforeStopping.
function preserveDataFromBeforeStopping(
	stoppedPodStatus: PodRuntimeStatus,
	podStatus: PodRuntimeStatus,
): void {
	stoppedPodStatus.ips = [...podStatus.ips];
}

// Models kubernetes/pkg/kubelet/kubelet.go isSyncPodWorthy.
function isSyncPodWorthy(event: PodLifecycleEvent): boolean {
	return event.type !== ContainerRemoved;
}

export interface KubeletDependencies {
	kubeClient: KubeClient | undefined;
	podListWatchClient: PodListWatchClient | undefined;
	serviceLister?: ServiceLister;
	serviceHasSynced?: () => boolean;
	recorder: EventRecorder;
	podStartupLatencyTracker: PodStartupSLIObserver;
	remoteRuntimeService?: RuntimeService;
	remoteImageService?: ImageManagerService;
	containerRuntime?: KubeletRuntime;
	runtimeCache?: RuntimeCache;
	commandRunner?: CommandRunner;
	network: ClusterNetwork;
	clock: Clock;
	podConfig?: PodConfig;
	nodeIPs?: string[];
}

// Models kubernetes/pkg/kubelet/kubelet.go SyncHandler.
export interface SyncHandler {
	handlePodAdditions(ctx: context.Context, pods: V1Pod[]): Promise<void>;
	handlePodUpdates(ctx: context.Context, pods: V1Pod[]): Promise<void>;
	handlePodRemoves(ctx: context.Context, pods: V1Pod[]): Promise<void>;
	handlePodReconcile(ctx: context.Context, pods: V1Pod[]): void;
	handlePodSyncs(ctx: context.Context, pods: V1Pod[]): Promise<void>;
	handlePodCleanups(ctx: context.Context): Promise<Error | undefined>;
}

// Models kubernetes/pkg/kubelet/kubelet.go serviceLister.
export interface ServiceLister {
	list(): Promise<[services: V1Service[], err: Error | undefined]>;
}

function expandEnvironment(input: string, envMap: Map<string, string>): string {
	let output = "";
	let checkpoint = 0;
	for (let cursor = 0; cursor < input.length; cursor++) {
		if (input[cursor] !== "$" || cursor + 1 >= input.length) {
			continue;
		}
		output += input.slice(checkpoint, cursor);
		const [read, isVar, advance] = tryReadVariableName(input.slice(cursor + 1));
		output += isVar ? (envMap.get(read) ?? `$(${read})`) : read;
		cursor += advance;
		checkpoint = cursor + 1;
	}
	return output + input.slice(checkpoint);
}

function tryReadVariableName(input: string): [read: string, isVar: boolean, advance: number] {
	const first = input[0];
	if (first === "$") {
		return ["$", false, 1];
	}
	if (first !== "(") {
		return [`$${first ?? ""}`, false, first === undefined ? 0 : 1];
	}
	const closer = input.indexOf(")", 1);
	if (closer === -1) {
		return ["$(", false, 1];
	}
	return [input.slice(1, closer), true, closer + 1];
}

const masterServices = new Set(["kubernetes"]);

function isServiceIPSet(service: V1Service): boolean {
	const clusterIP = service.spec?.clusterIP ?? "";
	return clusterIP !== "" && clusterIP !== "None";
}

function makeEnvVariableName(...parts: string[]): string {
	return parts.join("_").replaceAll("-", "_").toUpperCase();
}

function fromServices(services: V1Service[]): EnvVar[] {
	const result: EnvVar[] = [];
	for (const service of services) {
		const name = service.metadata?.name ?? "";
		const clusterIP = service.spec?.clusterIP ?? "";
		const ports = service.spec?.ports ?? [];
		for (const port of ports) {
			const protocol = port.protocol ?? "TCP";
			const protocolLower = protocol.toLowerCase();
			const portString = String(port.port);
			const hostPort = `${protocolLower}://${clusterIP}:${portString}`;
			const prefix = makeEnvVariableName(name);
			result.push({ name: `${prefix}_SERVICE_HOST`, value: clusterIP });
			result.push({ name: `${prefix}_SERVICE_PORT`, value: portString });
			result.push({ name: makeEnvVariableName(name, "PORT"), value: hostPort });
			result.push({
				name: makeEnvVariableName(name, "PORT", portString, protocol),
				value: hostPort,
			});
			result.push({
				name: makeEnvVariableName(name, "PORT", portString, protocol, "PROTO"),
				value: protocolLower,
			});
			result.push({
				name: makeEnvVariableName(name, "PORT", portString, protocol, "PORT"),
				value: portString,
			});
			result.push({
				name: makeEnvVariableName(name, "PORT", portString, protocol, "ADDR"),
				value: clusterIP,
			});
		}
	}
	return result;
}

// Models kubernetes/pkg/kubelet/kubelet.go makePodSourceConfig.
function makePodSourceConfig(
	ctx: context.Context,
	_kubeCfg: KubeletConfiguration,
	kubeDeps: KubeletDependencies,
	nodeName: string,
	nodeHasSynced: () => boolean,
	clock: Clock,
): [podConfig: PodConfig, err: Error | undefined] {
	const cfg = newPodConfig(kubeDeps.recorder, kubeDeps.podStartupLatencyTracker, clock);

	// Static pod file and URL sources are intentionally omitted: this simulator
	// has partial static pod bookkeeping but does not support static pods end to end.
	if (kubeDeps.kubeClient && kubeDeps.podListWatchClient) {
		newSourceApiserver(
			ctx,
			kubeDeps.podListWatchClient,
			nodeName,
			nodeHasSynced,
			cfg.channel(ctx, apiserverSource),
			clock,
		);
	}
	return [cfg, undefined];
}

export class NoopPodStartupSLIObserver implements PodStartupSLIObserver {
	observedPodOnWatch(_pod: V1Pod, _when: Date): void {}
}

// Models kubernetes/pkg/kubelet/kubelet.go NewMainKubelet.
export function newMainKubelet(
	ctx: context.Context,
	kubeCfg: KubeletConfiguration,
	kubeDeps: KubeletDependencies,
	hostname: string,
	nodeName: string,
): Kubelet {
	if (!kubeDeps.podConfig) {
		const [podConfig, podConfigErr] = makePodSourceConfig(
			ctx,
			kubeCfg,
			kubeDeps,
			nodeName,
			() => true,
			kubeDeps.clock,
		);
		if (podConfigErr) {
			throw podConfigErr;
		}
		kubeDeps.podConfig = podConfig;
	}
	return new Kubelet(ctx, kubeCfg, kubeDeps, hostname, nodeName);
}

// Models kubernetes/pkg/kubelet/kubelet.go Kubelet.
export class Kubelet implements RuntimeHelper {
	private readonly hostname: string;
	private readonly nodeName: string;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	readonly clock: Clock;
	private readonly kubeletConfiguration: KubeletConfiguration;
	private readonly kubeClient: KubeClient;
	// Package-visible for upstream-parity tests that mirror kubelet_pods_test.go.
	serviceLister: ServiceLister | undefined;
	// Package-visible for upstream-parity tests that mirror kubelet_pods_test.go.
	serviceHasSynced: () => boolean;
	private readonly podConfig: PodConfig;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	sourcesReady: SourcesReady;
	private readonly runtimeService: RuntimeService | undefined;
	private readonly imageService: ImageManagerService | undefined;
	// Package-visible for upstream-parity tests and Server wiring that mirror kubelet_test.go.
	readonly containerRuntime: KubeletRuntime;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	readonly runtimeCache: RuntimeCache;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	readonly runtimeState: RuntimeState;
	private readonly runner: CommandRunner;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	readonly podManager: PodManager;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	probeManager: ProbeManager;
	private readonly livenessManager: ResultsManager;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	readonly readinessManager: ResultsManager;
	private readonly startupManager: ResultsManager;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	podWorkers: PodWorkers & { close(): Promise<void> };
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	readonly podCache = new PodStatusCache();
	private readonly pleg: GenericPLEG;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	readonly statusManager: StatusManager;
	// Package-visible for upstream-parity tests that mirror kubelet_pods_test.go.
	recorder: EventRecorder;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	readonly workQueue: WorkQueue;
	private readonly runtimeManager: KubeGenericRuntimeManager | undefined;
	private readonly crashLoopBackOff: Backoff;
	// Models kubernetes/pkg/kubelet/kubelet.go Kubelet.PodSyncLoopHandlers.
	readonly podSyncLoopHandlers = new PodSyncLoopHandlers();
	// Models kubernetes/pkg/kubelet/kubelet.go Kubelet.PodSyncHandlers.
	readonly podSyncHandlers = new PodSyncHandlers();
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	syncLoopMonitor: Date | undefined;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	reasonCache = newReasonCache();
	// Package-visible for upstream-parity tests that mirror kubelet_pods_test.go.
	nodeIPs: string[];
	private readonly ctx: context.Context;
	private readonly cancelContext: context.CancelFunc;
	private syncLoopPromise: Promise<void> | undefined;
	private statusManagerPromise: Promise<void> | undefined;
	private closePromise: Promise<void> | undefined;
	private syncLoopExited = false;
	private stopped = false;

	public constructor(
		ctx: context.Context,
		kubeletConfiguration: KubeletConfiguration,
		kubeDeps: KubeletDependencies,
		hostname: string,
		nodeName: string,
	) {
		this.hostname = hostname;
		this.nodeName = nodeName;
		this.kubeletConfiguration = kubeletConfiguration;
		if (!kubeDeps.kubeClient) {
			throw new Error("standalone kubelet mode is not implemented");
		}
		if (!kubeDeps.podConfig) {
			throw new Error("pod config is required");
		}
		this.kubeClient = kubeDeps.kubeClient;
		this.serviceLister =
			kubeDeps.serviceLister ??
			({
				list: async () => {
					try {
						const services = await this.kubeClient.corev1.listServiceForAllNamespaces();
						return [services.items, undefined];
					} catch (error) {
						return [[], error instanceof Error ? error : new Error(String(error))];
					}
				},
			} satisfies ServiceLister);
		this.serviceHasSynced = kubeDeps.serviceHasSynced ?? (() => true);
		this.podConfig = kubeDeps.podConfig;
		this.nodeIPs = kubeDeps.nodeIPs ? [...kubeDeps.nodeIPs] : ["127.0.0.1", "::1"];
		this.sourcesReady = newSourcesReady(this.podConfig.seenAllSources.bind(this.podConfig));
		this.clock = kubeDeps.clock;
		this.runtimeState = newRuntimeState(maxWaitForContainerRuntimeMs, this.clock);
		// Simulator placeholder for the upstream runtime status updater, which is not
		// currently modeled as a separate loop.
		this.runtimeState.setRuntimeSync(this.clock.now());
		[this.ctx, this.cancelContext] = context.withCancel(ctx);
		this.runtimeService = kubeDeps.remoteRuntimeService;
		this.imageService = kubeDeps.remoteImageService;
		this.podManager = new PodManager();
		this.recorder = kubeDeps.recorder;
		this.statusManager = new StatusManager({
			clock: this.clock,
			kubeClient: this.kubeClient,
			podManager: this.podManager,
		});
		const livenessManager = new ResultsManager();
		const readinessManager = new ResultsManager();
		const startupManager = new ResultsManager();
		this.livenessManager = livenessManager;
		this.readinessManager = readinessManager;
		this.startupManager = startupManager;
		this.crashLoopBackOff = newBackOff(backOffPeriodMs, maxImageBackOffMs, this.clock);
		if (kubeDeps.containerRuntime) {
			this.runtimeManager = undefined;
			this.containerRuntime = kubeDeps.containerRuntime;
			this.runtimeCache =
				kubeDeps.runtimeCache ??
				newRuntimeCache(this.containerRuntime, runtimeCacheRefreshPeriodMs, this.clock);
			if (!kubeDeps.commandRunner) {
				throw new Error("command runner is required when container runtime is injected");
			}
			this.runner = kubeDeps.commandRunner;
		} else {
			if (!this.runtimeService || !this.imageService) {
				throw new Error("remote runtime and image services are required");
			}
			const runtimeImageService: ImageService = {
				pullImage: (ctx, image, credentials, podSandboxConfig) => {
					if (!this.runtimeManager) {
						throw new Error("runtime manager is not configured");
					}
					return this.runtimeManager.pullImage(ctx, image, credentials, podSandboxConfig);
				},
				getImageRef: (ctx, image) => {
					if (!this.runtimeManager) {
						throw new Error("runtime manager is not configured");
					}
					return this.runtimeManager.getImageRef(ctx, image);
				},
				listImages: (ctx) => {
					if (!this.runtimeManager) {
						throw new Error("runtime manager is not configured");
					}
					return this.runtimeManager.listImages(ctx);
				},
				removeImage: (ctx, image) => {
					if (!this.runtimeManager) {
						throw new Error("runtime manager is not configured");
					}
					return this.runtimeManager.removeImage(ctx, image);
				},
				imageStats: (ctx) => {
					if (!this.runtimeManager) {
						throw new Error("runtime manager is not configured");
					}
					return this.runtimeManager.imageStats(ctx);
				},
				imageFsInfo: (ctx) => {
					if (!this.runtimeManager) {
						throw new Error("runtime manager is not configured");
					}
					return this.runtimeManager.imageFsInfo(ctx);
				},
				getImageSize: (ctx, image) => {
					if (!this.runtimeManager) {
						throw new Error("runtime manager is not configured");
					}
					return this.runtimeManager.getImageSize(ctx, image);
				},
			};
			this.runtimeManager = new KubeGenericRuntimeManager({
				ctx: this.ctx,
				runtimeService: this.runtimeService,
				imageService: this.imageService,
				runtimeHelper: this,
				imagePuller: new KubeletImageManager({
					recorder: this.recorder,
					imageService: runtimeImageService,
					clock: this.clock,
					imageBackOff: newBackOff(imageBackOffPeriodMs, maxImageBackOffMs, this.clock),
					maxParallelImagePulls: this.maxParallelImagePulls(),
				}),
				events: this.recorder,
				internalLifecycle: newFakeInternalContainerLifecycle(),
				livenessManager,
				startupManager,
				clock: this.clock,
			});
			this.containerRuntime = this.runtimeManager;
			this.runtimeCache = newRuntimeCache(
				this.containerRuntime,
				runtimeCacheRefreshPeriodMs,
				this.clock,
			);
			this.runner = this.runtimeManager;
			this.runtimeManager.setHandlerRunner(
				newHandlerRunner({
					clock: this.clock,
					commandRunner: this.runner,
					containerManager: this.containerRuntime,
					eventRecorder: this.recorder,
					network: kubeDeps.network,
				}),
			);
		}
		this.probeManager = new ProbeManagerImpl(
			this.ctx,
			this.statusManager,
			livenessManager,
			readinessManager,
			startupManager,
			this.runner,
			this.recorder,
			this.clock,
			kubeDeps.network,
		);
		this.workQueue = new BasicWorkQueue(this.clock);
		this.pleg = new GenericPLEG(
			this.containerRuntime,
			new Channel<PodLifecycleEvent>(100),
			{
				relistPeriodMs: 1000,
				relistThresholdMs: 3 * 60 * 1000,
			},
			this.podCache,
			this.clock,
			this.ctx,
		);
		this.podWorkers = new PodWorkersImpl(
			this.clock,
			this.workQueue,
			this.kubeletConfiguration.syncFrequencyMs,
			backOffPeriodMs,
			{
				syncPod: (ctx, updateType, pod, mirrorPod, podStatus) =>
					this.syncPod(ctx, updateType, pod, mirrorPod, podStatus),
				syncTerminatingPod: (ctx, pod, podStatus, gracePeriod, podStatusFn) =>
					this.syncTerminatingPod(ctx, pod, podStatus, gracePeriod, podStatusFn),
				syncTerminatingRuntimePod: (ctx, runningPod) =>
					this.syncTerminatingRuntimePod(ctx, runningPod),
				syncTerminatedPod: (ctx, pod, podStatus) => this.syncTerminatedPod(ctx, pod, podStatus),
			},
			this.podCache,
		);
		const [activeDeadlineHandler, activeDeadlineHandlerErr] = newActiveDeadlineHandler(
			this.statusManager,
			this.recorder,
			this.clock,
		);
		if (activeDeadlineHandlerErr) {
			throw activeDeadlineHandlerErr;
		}
		if (activeDeadlineHandler) {
			this.addPodSyncLoopHandler(activeDeadlineHandler);
			this.addPodSyncHandler(activeDeadlineHandler);
		}
	}

	// Models kubernetes/pkg/kubelet/lifecycle/interfaces.go PodSyncLoopHandlers.AddPodSyncLoopHandler.
	addPodSyncLoopHandler(a: PodSyncLoopHandler): void {
		this.podSyncLoopHandlers.addPodSyncLoopHandler(a);
	}

	// Models kubernetes/pkg/kubelet/lifecycle/interfaces.go PodSyncHandlers.AddPodSyncHandler.
	addPodSyncHandler(a: PodSyncHandler): void {
		this.podSyncHandlers.addPodSyncHandler(a);
	}

	// Models kubernetes/pkg/kubelet/kubelet.go Run.
	async run(): Promise<void> {
		this.statusManagerPromise = this.statusManager.start(this.ctx);
		this.pleg.start();
		this.syncLoopPromise = this.syncLoop(this.ctx, this.podConfig.updates());
	}

	close(): Promise<void> {
		if (!this.closePromise) {
			this.stopped = true;
			this.cancelContext();
			this.closePromise = (async () => {
				await this.pleg.stop();
				this.podCache.updateTime(this.clock.now());
				if (this.probeManager instanceof ProbeManagerImpl) {
					await this.probeManager.close();
				}
				await this.podWorkers.close();
				await this.syncLoopPromise;
				await this.statusManagerPromise;
			})();
		}
		return this.closePromise;
	}

	isSyncLoopExited(): boolean {
		return this.syncLoopExited;
	}

	probeWorkerCount(): number {
		if (this.probeManager instanceof ProbeManagerImpl) {
			return this.probeManager.workerCount();
		}
		return 0;
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go GenerateRunContainerOptions.
	async generateRunContainerOptions(
		ctx: context.Context,
		pod: V1Pod,
		container: V1Container,
		podIP: string,
		podIPs: string[],
		_imageVolumes: unknown,
	): Promise<
		[
			containerOptions: RunContainerOptions | undefined,
			cleanupAction: undefined,
			err: Error | undefined,
		]
	> {
		const [envs, envErr] = await this.makeEnvironmentVariables(ctx, pod, container, podIP, podIPs);
		if (envErr) {
			return [undefined, undefined, envErr];
		}
		return [
			{
				envs,
				podContainerDir:
					container.terminationMessagePath !== undefined
						? this.getPodContainerDir(pod.metadata?.uid ?? "", container.name)
						: undefined,
			},
			undefined,
			undefined,
		];
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go getServiceEnvVarMap.
	private async getServiceEnvVarMap(
		ns: string,
		enableServiceLinks: boolean,
	): Promise<[serviceEnv: Map<string, string>, err: Error | undefined]> {
		const serviceMap = new Map<string, V1Service>();
		const m = new Map<string, string>();
		if (!this.serviceLister) {
			return [m, undefined];
		}
		const [services, servicesErr] = await this.serviceLister.list();
		if (servicesErr) {
			return [m, new Error("failed to list services when setting up env vars")];
		}

		for (const service of services) {
			if (!isServiceIPSet(service)) {
				continue;
			}
			const serviceName = service.metadata?.name ?? "";
			const serviceNamespace = service.metadata?.namespace ?? "default";
			if (serviceNamespace === "default" && masterServices.has(serviceName)) {
				if (!serviceMap.has(serviceName)) {
					serviceMap.set(serviceName, service);
				}
			} else if (serviceNamespace === ns && enableServiceLinks) {
				serviceMap.set(serviceName, service);
			}
		}

		for (const e of fromServices([...serviceMap.values()])) {
			m.set(e.name, e.value);
		}
		return [m, undefined];
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go makeEnvironmentVariables.
	async makeEnvironmentVariables(
		ctx: context.Context,
		pod: V1Pod,
		container: V1Container,
		podIP: string,
		podIPs: string[],
	): Promise<[envs: EnvVar[], err: Error | undefined]> {
		if (pod.spec?.enableServiceLinks === undefined) {
			return [
				[],
				new Error("nil pod.spec.enableServiceLinks encountered, cannot construct envvars"),
			];
		}
		if (!isStaticPod(pod) && !this.serviceHasSynced()) {
			return [
				[],
				new Error("services have not yet been read at least once, cannot construct envvars"),
			];
		}

		const result: EnvVar[] = [];
		const [serviceEnv, serviceEnvErr] = await this.getServiceEnvVarMap(
			pod.metadata?.namespace ?? "default",
			pod.spec.enableServiceLinks,
		);
		if (serviceEnvErr) {
			return [result, serviceEnvErr];
		}
		const tmpEnv = new Map<string, string>();
		for (const envVar of container.env ?? []) {
			let runtimeVal = envVar.value ?? "";
			if (runtimeVal.length > 0) {
				runtimeVal = expandEnvironment(runtimeVal, new Map([...tmpEnv, ...serviceEnv]));
			} else if (envVar.valueFrom?.fieldRef) {
				const [fieldValue, fieldErr] = this.podFieldSelectorRuntimeValue(
					ctx,
					envVar.valueFrom.fieldRef,
					pod,
					podIP,
					podIPs,
				);
				if (fieldErr) {
					return [result, fieldErr];
				}
				runtimeVal = fieldValue;
			}
			tmpEnv.set(envVar.name, runtimeVal);
		}

		for (const [name, value] of tmpEnv) {
			result.push({ name, value });
		}
		for (const [name, value] of serviceEnv) {
			if (!tmpEnv.has(name)) {
				result.push({ name, value });
			}
		}
		return [result, undefined];
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go podFieldSelectorRuntimeValue.
	private podFieldSelectorRuntimeValue(
		ctx: context.Context,
		fs: { apiVersion?: string; fieldPath: string },
		pod: V1Pod,
		podIP: string,
		podIPs: string[],
	): [value: string, err: Error | undefined] {
		const sortedPodIPs = this.sortPodIPs([...podIPs]);
		const selectedPodIP = sortedPodIPs[0] ?? podIP;
		switch (fs.fieldPath) {
			case "metadata.name":
				return [pod.metadata?.name ?? "", undefined];
			case "metadata.namespace":
				return [pod.metadata?.namespace ?? "default", undefined];
			case "spec.nodeName":
				return [pod.spec?.nodeName ?? "", undefined];
			case "spec.serviceAccountName":
				return [pod.spec?.serviceAccountName ?? "", undefined];
			case "status.hostIP": {
				const [hostIPs, err] = this.getHostIPsAnyWay(ctx);
				return [hostIPs[0] ?? "", err];
			}
			case "status.hostIPs": {
				const [hostIPs, err] = this.getHostIPsAnyWay(ctx);
				return [hostIPs.join(","), err];
			}
			case "status.podIP":
				return [selectedPodIP, undefined];
			case "status.podIPs":
				return [sortedPodIPs.join(","), undefined];
			default:
				return ["", new Error(`unsupported pod field selector: ${fs.fieldPath}`)];
		}
	}

	// Models kubernetes/pkg/kubelet/network/dns/dns.go Configurer.GetPodDNS.
	async getPodDNS(
		ctx: context.Context,
		pod: V1Pod,
	): Promise<[dnsConfig: DnsConfig | undefined, err: Error | undefined]> {
		const configurer = new Configurer({
			recorder: this.recorder,
			nodeRef: {
				kind: "Node",
				name: this.nodeName,
				uid: this.nodeName,
				namespace: "",
			},
			nodeIPs: this.nodeIPs,
			clusterDNS: this.kubeletConfiguration.clusterDNS,
			clusterDomain: this.kubeletConfiguration.clusterDomain,
			resolverConfig: "",
		});
		return await configurer.getPodDNS(ctx, pod);
	}

	private maxParallelImagePulls(): number | undefined {
		if (this.kubeletConfiguration.serializeImagePulls) {
			return 1;
		}
		return this.kubeletConfiguration.maxParallelImagePulls;
	}

	getPodCgroupParent(_pod: V1Pod): string {
		return "";
	}

	getPodDir(podUid: string): string {
		return `/pods/${podUid}`;
	}

	private getPodContainerDir(podUid: string, containerName: string): string {
		return `${this.getPodDir(podUid)}/containers/${containerName}`;
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go GeneratePodHostNameAndDomain.
	generatePodHostNameAndDomain(
		pod: V1Pod,
	): [hostname: string, hostDomain: string, err: Error | undefined] {
		const namespace = pod.metadata?.namespace ?? "default";
		const podName = pod.metadata?.name ?? "";
		const hostnameOverride = pod.spec?.hostnameOverride;
		if (hostnameOverride !== undefined) {
			const validationErrors = isDNS1123Subdomain(hostnameOverride);
			if (validationErrors.length !== 0) {
				return [
					"",
					"",
					new Error(
						`pod HostnameOverride "${hostnameOverride}" is not a valid DNS subdomain: ${validationErrors.join(";")}`,
					),
				];
			}
			const [truncatedHostname, err] = truncatePodHostnameIfNeeded(podName, hostnameOverride);
			if (err) {
				return ["", "", err];
			}
			return [truncatedHostname, "", undefined];
		}

		let hostname = podName;
		if ((pod.spec?.hostname ?? "").length > 0) {
			const podHostname = pod.spec?.hostname ?? "";
			const validationErrors = isDNS1123Label(podHostname);
			if (validationErrors.length !== 0) {
				return [
					"",
					"",
					new Error(
						`pod Hostname "${podHostname}" is not a valid DNS label: ${validationErrors.join(";")}`,
					),
				];
			}
			hostname = podHostname;
		}
		const [truncatedHostname, hostnameErr] = truncatePodHostnameIfNeeded(podName, hostname);
		if (hostnameErr) {
			return ["", "", hostnameErr];
		}

		const clusterDomain = this.kubeletConfiguration.clusterDomain;
		let hostDomain = "";
		if ((pod.spec?.subdomain ?? "").length > 0) {
			const podSubdomain = pod.spec?.subdomain ?? "";
			const validationErrors = isDNS1123Label(podSubdomain);
			if (validationErrors.length !== 0) {
				return [
					"",
					"",
					new Error(
						`pod Subdomain "${podSubdomain}" is not a valid DNS label: ${validationErrors.join(";")}`,
					),
				];
			}
			hostDomain = `${podSubdomain}.${namespace}.svc.${clusterDomain}`;
		}
		return [truncatedHostname, hostDomain, undefined];
	}

	getExtraSupplementalGroupsForPod(_pod: V1Pod): number[] {
		return [];
	}

	getOrCreateUserNamespaceMappings(
		_pod: V1Pod | undefined,
		_runtimeHandler: string,
	): [userNamespace: undefined, err: undefined] {
		return [undefined, undefined];
	}

	prepareDynamicResources(_ctx: context.Context, _pod: V1Pod): undefined {
		return undefined;
	}

	unprepareDynamicResources(_ctx: context.Context, _pod: V1Pod): undefined {
		return undefined;
	}

	requestPodReinspect(podUid: string): void {
		this.pleg.requestReinspect(podUid);
	}

	requestPodRelist(podUid: string): void {
		this.pleg.requestRelist(podUid);
	}

	podCPUAndMemoryStats(
		_ctx: context.Context,
		_pod: V1Pod,
		_podStatus: PodRuntimeStatus,
	): [podStats: undefined, err: undefined] {
		return [undefined, undefined];
	}

	onPodSandboxReady(_ctx: context.Context, _pod: V1Pod): undefined {
		return undefined;
	}

	async probeResultChannelsAreOpen(): Promise<boolean> {
		for (const updates of [
			this.livenessManager.updates(),
			this.readinessManager.updates(),
			this.startupManager.updates(),
		]) {
			const open = await select()
				.case(updates, ({ ok }) => ok)
				.default(() => true);
			if (!open) {
				return false;
			}
		}
		return true;
	}

	// Models kubernetes/pkg/kubelet/kubelet.go syncLoop.
	async syncLoop(
		ctx: context.Context,
		updates: ReadOnlyChannel<PodUpdate>,
		handler: SyncHandler = this,
	): Promise<void> {
		const syncTicker = new time.Ticker(this.clock, syncTickerPeriodMs);
		const housekeepingTicker = new time.Ticker(this.clock, housekeepingPeriodMs);
		const plegCh = this.pleg.watch();
		let duration = syncLoopRuntimeBackoffBaseMs;
		try {
			while (!this.stopped && !ctx.err()) {
				const err = this.runtimeState.runtimeErrors();
				if (err) {
					const selected = await select()
						.case(ctx.done(), () => "done")
						.case(time.after(this.clock, duration), () => "timeout");
					if (selected === "done") {
						break;
					}
					duration = Math.min(syncLoopRuntimeBackoffMaxMs, syncLoopRuntimeBackoffFactor * duration);
					continue;
				}
				duration = syncLoopRuntimeBackoffBaseMs;

				this.syncLoopMonitor = this.clock.now();
				if (
					!(await this.syncLoopIteration(
						ctx,
						updates,
						handler,
						syncTicker.C,
						housekeepingTicker.C,
						plegCh,
					))
				) {
					break;
				}
				this.syncLoopMonitor = this.clock.now();
			}
		} finally {
			syncTicker.stop();
			housekeepingTicker.stop();
			this.syncLoopExited = true;
		}
	}

	// Models kubernetes/pkg/kubelet/kubelet.go syncLoopIteration.
	async syncLoopIteration(
		ctx: context.Context,
		configCh: ReadOnlyChannel<PodUpdate>,
		handler: SyncHandler,
		syncCh: ReadOnlyChannel<Date>,
		housekeepingCh: ReadOnlyChannel<Date>,
		plegCh: ReadOnlyChannel<PodLifecycleEvent>,
	): Promise<boolean> {
		return await select()
			.case(configCh, async ({ ok, value }) => {
				if (!ok) {
					return false;
				}
				await this.handlePodUpdateWithHandler(ctx, value, handler);
				return true;
			})
			.case(plegCh, async ({ ok, value }) => {
				if (ok) {
					await this.handlePlegEvent(ctx, value, handler);
				}
				return true;
			})
			.case(syncCh, async ({ ok }) => {
				if (ok) {
					const podsToSync = this.getPodsToSync();
					if (podsToSync.length > 0) {
						await handler.handlePodSyncs(ctx, podsToSync);
					}
				}
				return true;
			})
			.case(this.livenessManager.updates(), async ({ ok, value }) => {
				if (ok && value.result === "failure") {
					await this.handleProbeSync(ctx, value, "liveness", "unhealthy", handler);
				}
				return true;
			})
			.case(this.readinessManager.updates(), async ({ ok, value }) => {
				if (ok) {
					const ready = value.result === "success";
					this.statusManager.setContainerReadiness(value.podUid, value.containerId, ready);

					const status = ready ? "ready" : "not ready";
					await this.handleProbeSync(ctx, value, "readiness", status, handler);
				}
				return true;
			})
			.case(this.startupManager.updates(), async ({ ok, value }) => {
				if (ok) {
					const started = value.result === "success";
					this.statusManager.setContainerStartup(value.podUid, value.containerId, started);

					const status = started ? "started" : "unhealthy";
					await this.handleProbeSync(ctx, value, "startup", status, handler);
				}
				return true;
			})
			.case(this.containerManagerUpdates(), async ({ ok, value }) => {
				if (ok) {
					const pods: V1Pod[] = [];
					for (const podUID of value.podUIDs) {
						const pod = this.podManager.getPodByUid(podUID);
						if (pod) {
							pods.push(pod);
						}
					}
					if (pods.length > 0) {
						await handler.handlePodSyncs(ctx, pods);
					}
				}
				return true;
			})
			.case(housekeepingCh, async ({ ok }) => {
				if (ok) {
					if (this.sourcesReady.allReady()) {
						const err = await handler.handlePodCleanups(ctx);
						if (err) {
							// The simulator does not currently model klog; upstream logs this error
							// and continues the sync loop.
						}
					}
				}
				return true;
			})
			.case(ctx.done(), () => false);
	}

	// Models kubernetes/pkg/kubelet/kubelet.go getPodsToSync.
	getPodsToSync(): V1Pod[] {
		const allPods = this.podManager.getPods();
		const podUIDs = this.workQueue.getWork();
		const podUIDSet = new Set<string>();
		for (const podUID of podUIDs) {
			podUIDSet.add(podUID);
		}
		const podsToSync: V1Pod[] = [];
		for (const pod of allPods) {
			const uid = pod.metadata?.uid;
			if (uid && podUIDSet.has(uid)) {
				podsToSync.push(pod);
				continue;
			}
			for (const podSyncLoopHandler of this.podSyncLoopHandlers) {
				if (podSyncLoopHandler.shouldSync(pod)) {
					podsToSync.push(pod);
					break;
				}
			}
		}
		return podsToSync;
	}

	// Models kubernetes/pkg/kubelet/kubelet.go syncLoopIteration configCh case.
	private async handlePodUpdate(ctx: context.Context, update: PodUpdate): Promise<void> {
		await this.handlePodUpdateWithHandler(ctx, update, this);
	}

	private async handlePodUpdateWithHandler(
		ctx: context.Context,
		update: PodUpdate,
		handler: SyncHandler,
	): Promise<void> {
		switch (update.op) {
			case "ADD":
				await handler.handlePodAdditions(ctx, update.pods);
				break;
			case "UPDATE":
				await handler.handlePodUpdates(ctx, update.pods);
				break;
			case "RECONCILE":
				handler.handlePodReconcile(ctx, update.pods);
				break;
			case "DELETE":
				// DELETE is treated as UPDATE because graceful deletion first
				// updates the pod with a deletion timestamp.
				await handler.handlePodUpdates(ctx, update.pods);
				break;
			case "REMOVE":
				await handler.handlePodRemoves(ctx, update.pods);
				break;
		}
		this.sourcesReady.addSource(update.source);
	}

	// Models kubernetes/pkg/kubelet/kubelet.go syncLoopIteration plegCh case.
	private async handlePlegEvent(
		ctx: context.Context,
		event: PodLifecycleEvent,
		handler: SyncHandler = this,
	): Promise<void> {
		if (isSyncPodWorthy(event)) {
			const pod = this.podManager.getPodByUid(event.id);
			if (pod) {
				await handler.handlePodSyncs(ctx, [pod]);
			}
		}
		if (event.type === ContainerDied && event.data) {
			await this.cleanUpContainersInPod(ctx, event.id, event.data);
		}
	}

	// Models kubernetes/pkg/kubelet/kubelet.go handleProbeSync.
	private async handleProbeSync(
		ctx: context.Context,
		update: ProbeUpdate,
		probe: "liveness" | "readiness" | "startup",
		status: string,
		handler: SyncHandler = this,
	): Promise<void> {
		if (this.stopped || !update.podUid) {
			return;
		}
		void probe;
		void status;
		// We should not use the pod from the prober manager, because it is never
		// updated after initialization.
		const pod = this.podManager.getPodByUid(update.podUid);
		if (!pod) {
			return;
		}
		await handler.handlePodSyncs(ctx, [pod]);
	}

	private containerManagerUpdates(): ReadOnlyChannel<{ podUIDs: string[] }> | undefined {
		// The simulator does not currently model kubelet's container manager update channel.
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kubelet.go HandlePodAdditions.
	async handlePodAdditions(ctx: context.Context, pods: V1Pod[]): Promise<void> {
		const start = this.clock.now();
		for (const pod of pods) {
			// Always add the pod to the pod manager. Kubelet relies on the pod
			// manager as the source of truth for the desired state.
			this.podManager.addPod(pod);
			const { pod: resolvedPod, mirrorPod } = this.podManager.getPodAndMirrorPod(pod);
			if (!resolvedPod) {
				continue;
			}
			// Kubernetes checks allocationManager admission here and calls
			// rejectPod on rejection. The simulator does not model pod resource
			// allocation, resize admission, or allocationManager state.
			await this.podWorkers.updatePod(ctx, {
				pod: resolvedPod,
				mirrorPod,
				updateType: "create",
				startTime: start,
			});
		}
	}

	// Models kubernetes/pkg/kubelet/kubelet.go HandlePodUpdates.
	async handlePodUpdates(ctx: context.Context, pods: V1Pod[]): Promise<void> {
		const start = this.clock.now();
		for (const pod of pods) {
			if (this.stopped || pod.spec?.nodeName !== this.nodeName || !pod.metadata?.name) {
				continue;
			}
			this.podManager.updatePod(pod);
			const { pod: resolvedPod, mirrorPod } = this.podManager.getPodAndMirrorPod(pod);
			if (!resolvedPod) {
				continue;
			}
			await this.podWorkers.updatePod(ctx, {
				pod: resolvedPod,
				mirrorPod,
				updateType: "update",
				startTime: start,
			});
		}
	}

	// Models kubernetes/pkg/kubelet/kubelet.go HandlePodRemoves.
	async handlePodRemoves(ctx: context.Context, pods: V1Pod[]): Promise<void> {
		const start = this.clock.now();
		for (const removedPod of pods) {
			this.podManager.removePod(removedPod);
			// Kubernetes forgets pod certificates and allocation manager state here.
			// Those subsystems are outside the simulator's current scope.
			const { pod, mirrorPod, wasMirror } = this.podManager.getPodAndMirrorPod(removedPod);
			if (wasMirror) {
				if (!pod) {
					continue;
				}
				await this.podWorkers.updatePod(ctx, {
					pod,
					mirrorPod,
					updateType: "update",
					startTime: start,
				});
				continue;
			}

			await this.deletePod(ctx, removedPod);
		}

		// Kubernetes retries pending resizes after pod removal. The simulator does
		// not model resource allocation or in-place pod vertical scaling.
	}

	// Models kubernetes/pkg/kubelet/kubelet.go deletePod.
	async deletePod(ctx: context.Context, pod: V1Pod | undefined): Promise<Error | undefined> {
		if (!pod) {
			return new Error("deletePod does not allow nil pod");
		}
		if (!this.sourcesReady.allReady()) {
			return new Error("skipping delete because sources aren't ready yet");
		}
		await this.podWorkers.updatePod(ctx, {
			pod,
			updateType: "kill",
			startTime: this.clock.now(),
		});
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kubelet.go rejectPod.
	async rejectPod(
		_ctx: context.Context,
		pod: V1Pod,
		reason: string,
		message: string,
	): Promise<void> {
		await this.recorder.eventf(pod, "Warning", reason, "%s", message);
		await this.statusManager.setPodStatus(pod, {
			qosClass: getPodQOS(pod),
			phase: "Failed",
			reason,
			message: `Pod was rejected: ${message}`,
		});
	}

	// Models kubernetes/pkg/kubelet/kubelet.go HandlePodReconcile.
	handlePodReconcile(_ctx: context.Context, pods: V1Pod[]): void {
		for (const pod of pods) {
			if (this.stopped || pod.spec?.nodeName !== this.nodeName || !pod.metadata?.name) {
				continue;
			}
			this.podManager.updatePod(pod);
		}
	}

	// Models kubernetes/pkg/kubelet/kubelet.go HandlePodSyncs.
	async handlePodSyncs(ctx: context.Context, pods: V1Pod[]): Promise<void> {
		const start = this.clock.now();
		for (const pod of pods) {
			const { pod: resolvedPod, mirrorPod, wasMirror } = this.podManager.getPodAndMirrorPod(pod);
			if (wasMirror) {
				continue;
			}
			await this.podWorkers.updatePod(ctx, {
				pod: resolvedPod,
				mirrorPod,
				updateType: "sync",
				startTime: start,
			});
		}
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go HandlePodCleanups.
	async handlePodCleanups(ctx: context.Context): Promise<Error | undefined> {
		const { allPods, allMirrorPods, orphanedMirrorPodFullnames } =
			this.podManager.getPodsAndMirrorPods();

		// Stop the workers for terminated pods not in the config source
		const workingPods = await this.podWorkers.syncKnownPods(allPods);

		// Identify the set of pods that have workers, which should be all pods
		// from config that are not terminated, as well as any terminating pods
		// that have already been removed from config.
		const possiblyRunningPods = new Set<string>();
		for (const [uid, sync] of workingPods) {
			switch (sync.state) {
				case "SyncPod":
				case "TerminatingPod":
					possiblyRunningPods.add(uid);
					break;
			}
		}

		// Retrieve the list of running containers from the runtime to perform cleanup.
		const updateErr = await this.runtimeCache.forceUpdateIfOlder(ctx, this.clock.now());
		if (updateErr) {
			return updateErr;
		}
		const [runningRuntimePods, runtimePodsErr] = await this.runtimeCache.getPods(ctx);
		if (runtimePodsErr) {
			return runtimePodsErr;
		}

		// Stop probing pods that are not running
		this.probeManager.cleanupPods(possiblyRunningPods);

		// Remove orphaned pod statuses not in the total list of known config pods
		this.statusManager.removeOrphanedStatuses(
			new Set(
				[...allPods, ...allMirrorPods]
					.map((pod) => pod.metadata?.uid)
					.filter((uid): uid is string => uid !== undefined),
			),
		);

		// Kubernetes removes allocation manager state, user namespaces, pod dirs,
		// volumes, and cgroups here. Those subsystems are outside the simulator's
		// current scope.

		for (const podFullname of orphanedMirrorPodFullnames) {
			if (await this.podWorkers.isPodForMirrorPodTerminatingByFullName(podFullname)) {
				continue;
			}
			// Mirror pod API deletion is not supported end to end in the simulator.
		}

		const activePods = await this.filterOutInactivePods(allPods);

		// At this point, the pod worker is aware of which pods are not desired (SyncKnownPods).
		// We now look through the set of active pods for those that the pod worker is not aware of
		// and deliver an update.
		for (const desiredPod of activePods) {
			const uid = desiredPod.metadata?.uid ?? "";
			if (!uid || workingPods.has(uid)) {
				continue;
			}

			const { pod, mirrorPod, wasMirror } = this.podManager.getPodAndMirrorPod(desiredPod);
			if (!pod || wasMirror) {
				continue;
			}
			await this.podWorkers.updatePod(ctx, {
				updateType: "create",
				pod,
				mirrorPod,
				startTime: this.clock.now(),
			});
			workingPods.set(uid, {
				state: "SyncPod",
				orphan: false,
				hasConfig: true,
				static: isStaticPod(desiredPod),
			});
		}

		for (const pod of this.filterTerminalPodsToDelete(
			allPods,
			runningRuntimePods,
			workingPods,
		).values()) {
			await this.podWorkers.updatePod(ctx, {
				updateType: "kill",
				pod,
				startTime: this.clock.now(),
			});
		}

		// Finally, terminate any pods that are observed in the runtime but not present in the list of
		// known running pods from config.
		for (const runningPod of runningRuntimePods) {
			const knownPod = workingPods.has(runningPod.id);
			if (!knownPod) {
				await this.podWorkers.updatePod(ctx, {
					updateType: "kill",
					runningPod,
					killPodOptions: {
						podTerminationGracePeriodSecondsOverride: 1,
					},
					startTime: this.clock.now(),
				});

				// the running pod is now known as well
				workingPods.set(runningPod.id, {
					state: "TerminatingPod",
					orphan: true,
					hasConfig: false,
					static: false,
				});
			}
		}

		this.crashLoopBackOff.gc();
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go filterOutInactivePods.
	async filterOutInactivePods(pods: V1Pod[]): Promise<V1Pod[]> {
		const filteredPods: V1Pod[] = [];
		for (const pod of pods) {
			if (await this.isPodInactive(pod)) {
				continue;
			}
			filteredPods.push(pod);
		}
		return filteredPods;
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go isPodInactive.
	private async isPodInactive(pod: V1Pod): Promise<boolean> {
		const uid = pod.metadata?.uid ?? "";
		if (await this.podWorkers.isPodKnownTerminated(uid)) {
			return true;
		}
		if (
			this.isAdmittedPodTerminal(pod) &&
			!(await this.podWorkers.isPodTerminationRequested(uid))
		) {
			return true;
		}
		return false;
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go isAdmittedPodTerminal.
	private isAdmittedPodTerminal(pod: V1Pod): boolean {
		if (isPodPhaseTerminal(pod.status?.phase)) {
			return true;
		}
		const status = this.statusManager.getPodStatus(pod.metadata?.uid ?? "");
		return isPodPhaseTerminal(status?.phase);
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go filterTerminalPodsToDelete.
	private filterTerminalPodsToDelete(
		allPods: V1Pod[],
		runningRuntimePods: RuntimePod[],
		workingPods: Map<string, unknown>,
	): Map<string, V1Pod> {
		const terminalPodsToDelete = new Map<string, V1Pod>();
		for (const pod of allPods) {
			const uid = pod.metadata?.uid ?? "";
			if (!pod.metadata?.deletionTimestamp) {
				continue;
			}
			if (!isPodPhaseTerminal(pod.status?.phase)) {
				continue;
			}
			if (workingPods.has(uid)) {
				continue;
			}
			terminalPodsToDelete.set(uid, pod);
		}
		for (const runningRuntimePod of runningRuntimePods) {
			terminalPodsToDelete.delete(runningRuntimePod.id);
		}
		return terminalPodsToDelete;
	}

	async exec(
		namespace: string,
		podName: string,
		containerName: string | undefined,
		argv: string[],
	): Promise<ExecResult> {
		const [runtimePods, runtimePodsErr] = await this.containerRuntime.getPods(this.ctx, false);
		if (runtimePodsErr) {
			throw runtimePodsErr;
		}
		const runtimePod = runtimePods.find(
			(pod) => pod.namespace === namespace && pod.name === podName,
		);
		if (!runtimePod) {
			throw new Error(`pod ${namespace}/${podName} is not running on node ${this.nodeName}`);
		}
		const container = containerName
			? runtimePod.containers.find((candidate) => candidate.name === containerName)
			: runtimePod.containers.length === 1
				? runtimePod.containers[0]
				: undefined;
		if (!container) {
			throw new Error(
				containerName
					? `container ${containerName} not found in pod ${namespace}/${podName}`
					: `container name is required for pod ${namespace}/${podName}`,
			);
		}
		if (!this.runtimeService) {
			throw new Error("remote runtime service is not configured");
		}
		const [response, err] = await this.runtimeService.execSync(this.ctx, container.id.id, argv);
		if (err) {
			throw err;
		}
		if (!response) {
			throw new Error("execSync returned no response");
		}
		return response;
	}

	// Models kubernetes/pkg/kubelet/kubelet.go SyncPod.
	async syncPod(
		ctx: context.Context,
		updateType: SyncPodType,
		pod: V1Pod | undefined,
		mirrorPod: V1Pod | undefined,
		podStatus: PodRuntimeStatus,
	): Promise<SyncPodResult> {
		if (ctx.err()) {
			return [false, undefined, undefined];
		}
		if (!pod) {
			throw new Error("SyncPod requires a pod");
		}

		if (updateType === "create") {
			// Kubernetes records pod worker start latency here. The simulator does
			// not currently expose kubelet metrics.
		}

		// Kubernetes updates resize/allocation-manager pod status here. The
		// simulator does not model pod resource allocation or in-place resizing.

		const apiPodStatus = this.generateAPIPodStatus(ctx, pod, podStatus, false);
		podStatus.ips = (apiPodStatus.podIPs ?? [])
			.map((podIP) => podIP.ip)
			.filter((ip): ip is string => ip !== undefined);
		if (podStatus.ips.length === 0 && apiPodStatus.podIP) {
			podStatus.ips = [apiPodStatus.podIP];
		}

		if (isPodPhaseTerminal(apiPodStatus.phase)) {
			await this.statusManager.setPodStatus(pod, apiPodStatus);
			return [true, undefined, undefined];
		}

		await this.statusManager.setPodStatus(pod, apiPodStatus);

		const networkErr = this.runtimeState.networkErrors();
		if (networkErr && !isHostNetworkPod(pod)) {
			return [
				false,
				undefined,
				new Error(`${networkNotReadyErrorMsg}: ${networkErr.message}`, { cause: networkErr }),
			];
		}

		if (!(await this.podWorkers.isPodTerminationRequested(pod.metadata?.uid ?? ""))) {
			// Kubernetes registers referenced secrets and configmaps here. The
			// simulator keeps image credential and configmap/secret resolution out
			// of kubelet sync scope for now.
		}

		if (!(await this.podWorkers.isPodTerminationRequested(pod.metadata?.uid ?? ""))) {
			// Kubernetes creates and updates pod cgroups/QOS hierarchy here. The
			// simulator does not model cgroups, resource requests, or limits.
		}

		// Kubernetes reconciles mirror pods for static pods here. Static pods and
		// mirror pods are not supported end to end by the simulator.

		// Kubernetes creates pod data directories here. The simulator does not use
		// kubelet-managed host pod directories.

		// Kubernetes waits for volumes to attach and mount here, and calls
		// rejectPod when volume attachment limits are exceeded. Volumes and CSI
		// are intentionally outside current simulator scope.

		const pullSecrets: unknown[] = [];
		// Kubernetes resolves image pull secrets here. Private registry
		// authentication is intentionally a no-op in the simulator.

		this.probeManager.addPod(ctx, pod);
		const restartAllContainers = shouldAllContainersRestart(pod, podStatus, apiPodStatus);
		const result = await this.containerRuntime.syncPod(
			ctx,
			pod,
			podStatus,
			pullSecrets,
			this.crashLoopBackOff,
			restartAllContainers,
		);
		this.reasonCache.update(pod.metadata?.uid ?? "", result);
		const err = result.error();
		if (restartAllContainers && !err) {
			const shouldRequeue = result.syncResults.some(
				(syncResult) => syncResult.action === "RemoveContainer" && !syncResult.error,
			);
			if (shouldRequeue) {
				await this.podWorkers.updatePod(ctx, {
					pod,
					mirrorPod,
					updateType: "update",
					startTime: this.clock.now(),
				});
			}
		}
		// Kubernetes handles resize errors here. The simulator does not model
		// in-place pod resize or allocation-manager behavior.

		// Kubernetes performs post-sync relist/requeue hooks here. The simulator
		// returns a PLEG relist callback below when runtime state changed.
		return [false, this.postSyncIfChanged(pod, result.syncResults.length > 0 && !err), err];
	}

	private postSyncIfChanged(pod: V1Pod, runtimeChanged: boolean): (() => void) | undefined {
		const uid = pod.metadata?.uid;
		if (!runtimeChanged || !uid) {
			return undefined;
		}
		return () => this.pleg.requestRelist(uid);
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go generateAPIPodStatus.
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	generateAPIPodStatus(
		ctx: context.Context,
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
		podIsTerminal: boolean,
	): V1PodStatus {
		void ctx;
		const oldPodStatus =
			this.statusManager.getPodStatus(pod.metadata?.uid ?? "") ?? pod.status ?? {};
		const status = this.convertStatusToAPIStatus(ctx, pod, podStatus, oldPodStatus);
		status.phase = getPhase(pod, status.containerStatuses ?? [], podIsTerminal);
		if (
			status.phase !== "Failed" &&
			status.phase !== "Succeeded" &&
			(oldPodStatus.phase === "Failed" || oldPodStatus.phase === "Succeeded")
		) {
			status.phase = oldPodStatus.phase;
		}
		if (
			status.phase !== "Failed" &&
			status.phase !== "Succeeded" &&
			(pod.status?.phase === "Failed" || pod.status?.phase === "Succeeded")
		) {
			status.phase = pod.status.phase;
		}
		if (pod.status?.phase === "Failed" || pod.status?.phase === "Succeeded") {
			status.phase = pod.status.phase;
		}
		if (status.phase === oldPodStatus.phase) {
			status.reason = oldPodStatus.reason || pod.status?.reason;
			status.message = oldPodStatus.message || pod.status?.message;
		} else {
			delete status.reason;
			delete status.message;
		}
		for (const handler of this.podSyncHandlers) {
			const result = handler.shouldEvict(pod);
			if (result.evict) {
				status.phase = "Failed";
				status.reason = result.reason;
				status.message = result.message;
				break;
			}
		}
		this.probeManager.updatePodStatus(ctx, pod, status);
		const conditions = (pod.status?.conditions ?? []).filter(
			(condition) => !kubetypes.podConditionByKubelet(condition.type),
		);
		const [, disruptionCondition] = podutil.getPodConditionFromList(
			oldPodStatus.conditions,
			"DisruptionTarget",
		);
		if (disruptionCondition) {
			const existingIndex = conditions.findIndex(
				(condition) => condition.type === disruptionCondition.type,
			);
			if (existingIndex >= 0) {
				conditions[existingIndex] = disruptionCondition;
			} else {
				conditions.push(disruptionCondition);
			}
		}
		const allContainerStatuses = status.containerStatuses ?? [];
		status.conditions = [
			...conditions,
			generatePodReadyToStartContainersCondition(pod, oldPodStatus, podStatus),
			generatePodInitializedCondition(pod, oldPodStatus, allContainerStatuses, status.phase),
		];
		status.conditions = [
			...status.conditions,
			generatePodReadyCondition(
				pod,
				oldPodStatus,
				status.conditions,
				allContainerStatuses,
				status.phase,
			),
			generateContainersReadyCondition(pod, oldPodStatus, allContainerStatuses, status.phase),
			{
				type: "PodScheduled",
				observedGeneration: podutil.calculatePodConditionObservedGeneration(
					oldPodStatus,
					pod.metadata?.generation ?? 0,
					"PodScheduled",
				),
				status: "True",
			},
		];
		if (allContainersCouldRestart(pod.spec)) {
			status.conditions.push(
				generateAllContainersRestartingCondition(pod, podStatus, oldPodStatus, status.phase),
			);
		}
		const [hostIPs, hostIPsErr] = this.getHostIPsAnyWay(ctx);
		if (!hostIPsErr && hostIPs.length > 0) {
			status.hostIP = hostIPs[0];
			status.hostIPs = hostIPs.map((ip) => ({ ip }));
			if (isHostNetworkPod(pod)) {
				if (!status.podIP) {
					status.podIP = hostIPs[0];
					status.podIPs = [{ ip: status.podIP }];
				}
				if (hostIPs.length === 2 && (status.podIPs?.length ?? 0) === 1) {
					status.podIPs = [...(status.podIPs ?? []), { ip: hostIPs[1] }];
				}
			}
		}
		return status;
	}

	// Models kubernetes/pkg/kubelet/kubelet_getters.go getHostIPsAnyWay.
	private getHostIPsAnyWay(ctx: context.Context): [hostIPs: string[], err: Error | undefined] {
		const err = ctx.err();
		if (err) {
			return [[], err];
		}
		return [[...this.nodeIPs], undefined];
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go convertStatusToAPIStatus.
	private convertStatusToAPIStatus(
		ctx: context.Context,
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
		oldPodStatus: V1PodStatus,
	): V1PodStatus {
		const podIPs = this.sortPodIPs([...podStatus.ips]);
		const apiPodStatus: V1PodStatus = {};
		if (podIPs.length > 0) {
			apiPodStatus.podIPs = podIPs.map((ip) => ({ ip }));
			apiPodStatus.podIP = apiPodStatus.podIPs[0]?.ip;
		}

		apiPodStatus.qosClass = getPodQOS(pod);
		apiPodStatus.containerStatuses = this.convertToAPIContainerStatuses(
			ctx,
			pod,
			podStatus,
			oldPodStatus.containerStatuses ?? [],
			pod.spec?.containers ?? [],
			undefined,
			false,
			false,
			false,
		);
		if ((pod.spec?.initContainers?.length ?? 0) > 0) {
			apiPodStatus.initContainerStatuses = [];
		}
		if ((pod.spec?.ephemeralContainers?.length ?? 0) > 0) {
			apiPodStatus.ephemeralContainerStatuses = [];
		}
		return apiPodStatus;
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go sortPodIPs.
	private sortPodIPs(podIPs: string[]): string[] {
		const ips: string[] = [];
		const appendFirstMatching = (valid: (ip: number[] | undefined) => boolean): void => {
			for (const ipString of podIPs) {
				const ip = parseIP(ipString);
				if (ip && valid(ip)) {
					ips.push(formatIP(ip));
					break;
				}
			}
		};

		const firstNodeIP = parseIP(this.nodeIPs[0] ?? "");
		if (!firstNodeIP || isIPv4(firstNodeIP)) {
			appendFirstMatching(isIPv4);
			appendFirstMatching(isIPv6);
		} else {
			appendFirstMatching(isIPv6);
			appendFirstMatching(isIPv4);
		}
		return ips;
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go convertToAPIContainerStatuses.
	convertToAPIContainerStatuses(
		ctx: context.Context,
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
		previousStatus: V1ContainerStatus[],
		containers: V1Container[],
		imageVolumeNames: Set<string> | undefined,
		hasInitContainers: boolean,
		_isInitContainer: boolean,
		podRestarting: boolean,
	): V1ContainerStatus[] {
		if (imageVolumeNames && imageVolumeNames.size > 0) {
			throw new Error("image volume status conversion is not implemented");
		}

		const convertContainerStatus = (
			cs: ContainerStatus,
			oldStatus: V1ContainerStatus | undefined,
		): V1ContainerStatus => {
			const cid = cs.id.toString();
			const status: V1ContainerStatus = {
				name: cs.name,
				restartCount: cs.restartCount,
				image: cs.image,
				imageID: cs.imageRef,
				containerID: cid,
				ready: false,
				resources: {},
			};
			if (oldStatus) {
				if (oldStatus.volumeMounts !== undefined) {
					status.volumeMounts = oldStatus.volumeMounts;
				}
				if (oldStatus.restartCount > status.restartCount) {
					status.restartCount = oldStatus.restartCount;
				}
				if (oldStatus.containerID !== status.containerID && oldStatus.state?.terminated) {
					status.lastState = { terminated: oldStatus.state.terminated };
				} else if (oldStatus.lastState?.terminated) {
					status.lastState = { terminated: oldStatus.lastState.terminated };
				}
			}

			switch (cs.state) {
				case "Running":
					status.state = {
						running: cs.startedAt !== undefined ? { startedAt: new Date(cs.startedAt) } : {},
					};
					if (oldStatus?.state?.terminated && oldStatus.restartCount >= cs.restartCount) {
						status.restartCount = oldStatus.restartCount + 1;
					}
					break;
				case "Created":
					// containers that are created but not running are "waiting to be running"
					status.state = { waiting: {} };
					break;
				case "Exited":
					const terminated: NonNullable<NonNullable<V1ContainerStatus["state"]>["terminated"]> = {
						exitCode: cs.exitCode ?? 0,
					};
					status.state = {
						terminated,
					};
					if (cs.reason !== undefined) {
						terminated.reason = cs.reason;
					}
					if (cs.message !== undefined) {
						terminated.message = cs.message;
					}
					if (cs.startedAt !== undefined) {
						terminated.startedAt = new Date(cs.startedAt);
					}
					if (cs.finishedAt !== undefined) {
						terminated.finishedAt = new Date(cs.finishedAt);
					}
					terminated.containerID = cid;
					break;
				case "Unknown":
					if (oldStatus?.state?.running) {
						const reason = podRestarting ? "RestartingAllContainers" : "ContainerStatusUnknown";
						status.state = {
							terminated: {
								reason,
								message: "The container could not be located when the pod was terminated",
								exitCode: 137,
							},
						};
						status.restartCount = oldStatus.restartCount + 1;
						break;
					}
					status.state = { waiting: {} };
					break;
			}
			return status;
		};

		// Fetch old containers statuses from old pod status.
		const oldStatuses = new Map<string, V1ContainerStatus>();
		for (const status of previousStatus) {
			oldStatuses.set(status.name, status);
		}

		// Set all container statuses to default waiting state
		const statuses = new Map<string, V1ContainerStatus>();
		const defaultWaitingState = {
			waiting: { reason: hasInitContainers ? "PodInitializing" : "ContainerCreating" },
		};

		for (const container of containers) {
			let status: V1ContainerStatus = {
				name: container.name,
				image: container.image ?? "",
				imageID: "",
				ready: false,
				restartCount: 0,
				state: structuredClone(defaultWaitingState),
			};
			const oldStatus = oldStatuses.get(container.name);
			if (oldStatus) {
				if (oldStatus.state?.terminated) {
					status = structuredClone(oldStatus);
				} else {
					// Apply some values from the old statuses as the default values.
					status.restartCount = oldStatus.restartCount;
					status.lastState = oldStatus.lastState;
				}
			}
			statuses.set(container.name, status);
		}

		for (const container of containers) {
			const found = podStatus.containerStatuses.some((cStatus) => container.name === cStatus.name);
			if (found) {
				continue;
			}

			const oldStatus = oldStatuses.get(container.name);
			if (!oldStatus) {
				continue;
			}

			if (podRestarting && oldStatus.state?.waiting === undefined) {
				const status = statuses.get(container.name);
				if (!status) {
					continue;
				}
				status.state = {
					waiting: {
						reason: "RestartingAllContainers",
						message: "The container is removed because RestartAllContainers in place",
					},
				};
				status.lastState = {
					terminated: {
						reason: "RestartingAllContainers",
						message: "The container is removed because RestartAllContainers in place",
						exitCode: 137,
					},
				};
				status.restartCount = oldStatus.restartCount + 1;
				statuses.set(container.name, status);
				continue;
			}

			if (oldStatus.state?.terminated) {
				// if the old container status was terminated, the lasttermination status is correct
				continue;
			}
			if (!oldStatus.state?.running) {
				// if the old container status isn't running, then waiting is an appropriate status and we have nothing to do
				continue;
			}

			const status = statuses.get(container.name);
			if (!status) {
				continue;
			}
			const isDefaultWaitingStatus =
				status.state?.waiting?.reason ===
				(hasInitContainers ? "PodInitializing" : "ContainerCreating");
			if (!isDefaultWaitingStatus) {
				// the status was written, don't override
				continue;
			}
			if (status.lastState?.terminated) {
				// if we already have a termination state, nothing to do
				continue;
			}

			status.lastState = {
				terminated: {
					reason: "ContainerStatusUnknown",
					message:
						"The container could not be located when the pod was deleted.  The container used to be Running",
					exitCode: 137,
				},
			};

			// If the pod was not deleted, then it's been restarted. Increment restart count.
			if (pod.metadata?.deletionTimestamp === undefined) {
				status.restartCount += 1;
			}

			statuses.set(container.name, status);
		}

		// Copy the slice before sorting it
		const containerStatusesCopy = [...podStatus.containerStatuses];

		// Make the latest container status comes first.
		containerStatusesCopy.sort((a, b) => b.createdAt - a.createdAt);
		// Set container statuses according to the statuses seen in pod status
		const containerSeen = new Map<string, number>();
		for (const cStatus of containerStatusesCopy) {
			const cName = cStatus.name;
			if (!statuses.has(cName)) {
				// This would also ignore the infra container.
				continue;
			}
			if ((containerSeen.get(cName) ?? 0) >= 2) {
				continue;
			}
			const oldStatus = oldStatuses.get(cName);
			const status = convertContainerStatus(cStatus, oldStatus);
			if (cStatus.state === "Running" && oldStatus?.started !== undefined) {
				status.started = oldStatus.started;
			}

			if ((containerSeen.get(cName) ?? 0) === 0) {
				statuses.set(cName, status);
			} else {
				const previous = statuses.get(cName);
				if (previous) {
					previous.lastState = status.state;
					statuses.set(cName, previous);
				}
			}
			containerSeen.set(cName, (containerSeen.get(cName) ?? 0) + 1);
		}

		// Handle the containers failed to be started, which should be in Waiting state.
		for (const container of containers) {
			if (!this.shouldContainerBeRestarted(container, pod, podStatus)) {
				continue;
			}
			const status = statuses.get(container.name);
			if (!status) {
				continue;
			}
			const [reason, ok] = this.reasonCache.get(pod.metadata?.uid ?? "", container.name);
			if (!ok || !reason) {
				continue;
			}
			if (status.state?.terminated) {
				status.lastState = status.state;
			}
			status.state = {
				waiting: {
					reason: reason.err.message,
					message: reason.message,
				},
			};
			statuses.set(container.name, status);
		}

		// Sort the container statuses since clients of this interface expect the list
		// of containers in a pod has a deterministic order.
		return containers
			.map((container) => statuses.get(container.name))
			.filter((status): status is V1ContainerStatus => status !== undefined);
	}

	// Models kubernetes/pkg/kubelet/container/helpers.go ShouldContainerBeRestarted.
	private shouldContainerBeRestarted(
		container: V1Container,
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
	): boolean {
		if (pod.metadata?.deletionTimestamp !== undefined) {
			return false;
		}
		const status = podStatus.containerStatuses.find(
			(candidate) => candidate.name === container.name,
		);
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

	// Models kubernetes/pkg/kubelet/kubelet_pods.go killPod.
	private async killPod(
		ctx: context.Context,
		pod: V1Pod,
		p: RuntimePod,
		gracePeriodOverride: number | undefined,
	): Promise<Error | undefined> {
		const err = await this.containerRuntime.killPod(ctx, pod, p, gracePeriodOverride);
		if (err) {
			return err;
		}
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kubelet.go SyncTerminatingPod.
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	async syncTerminatingPod(
		ctx: context.Context,
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
		gracePeriod: number | undefined,
		podStatusFn: ((status: V1PodStatus) => void) | undefined,
	): Promise<Error | undefined> {
		const apiPodStatus = this.generateAPIPodStatus(ctx, pod, podStatus, false);
		podStatusFn?.(apiPodStatus);
		await this.statusManager.setPodStatus(pod, apiPodStatus);

		this.probeManager.stopLivenessAndStartup(pod);

		const p = convertPodStatusToRunningPod("simulator", podStatus);
		for (const container of p.containers) {
			await this.recorder.event(pod, "Normal", "Killing", `Stopping container ${container.name}`);
		}
		const killErr = await this.killPod(ctx, pod, p, gracePeriod);
		if (killErr) {
			return new Error(`error killing terminating pod: ${killErr.message}`, { cause: killErr });
		}

		this.probeManager.removePod(pod);

		let runtimePod: RuntimePod;
		try {
			runtimePod = await this.getRuntimePod(ctx, pod);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			return new Error(`unable to get pod prior to final pod termination: ${err.message}`);
		}
		const [stoppedPodStatus, podStatusErr] = await this.containerRuntime.getPodStatus(
			ctx,
			runtimePod,
		);
		if (podStatusErr) {
			return new Error(
				`unable to read pod status prior to final pod termination: ${podStatusErr.message}`,
				{
					cause: podStatusErr,
				},
			);
		}
		if (!stoppedPodStatus) {
			return new Error(
				`pod status not found for ${pod.metadata?.namespace ?? "default"}/${pod.metadata?.name ?? ""}`,
			);
		}
		preserveDataFromBeforeStopping(stoppedPodStatus, podStatus);

		const runningContainers: string[] = [];
		for (const status of stoppedPodStatus.containerStatuses) {
			if (status.state === "Running") {
				runningContainers.push(status.id.toString());
			}
		}
		if (runningContainers.length > 0) {
			return new Error(
				`detected running containers after a successful KillPod, CRI violation: ${runningContainers.join(", ")}`,
			);
		}

		// Kubernetes unprepares DynamicResourceAllocation resources here. The
		// simulator does not model DRA, volumes, or CSI resources.
		await this.statusManager.setPodStatus(
			pod,
			this.generateAPIPodStatus(ctx, pod, stoppedPodStatus, true),
		);
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kubelet.go SyncTerminatingRuntimePod.
	private async syncTerminatingRuntimePod(
		ctx: context.Context,
		runningPod: RuntimePod,
	): Promise<Error | undefined> {
		if (ctx.err()) {
			return context.Canceled;
		}
		const pod = toAPIPod(runningPod);
		const gracePeriod = 1;
		for (const container of runningPod.containers) {
			await this.recorder.event(pod, "Normal", "Killing", `Stopping container ${container.name}`);
		}
		const killErr = await this.killPod(ctx, pod, runningPod, gracePeriod);
		if (killErr) {
			return killErr;
		}
		if (this.runtimeService) {
			for (const sandbox of runningPod.sandboxes) {
				const err = await this.runtimeService.removePodSandbox(ctx, sandbox.id.id);
				if (err) {
					return err;
				}
			}
		}
		// Kubernetes relies on runtime garbage collection after killing runtime-only
		// pods. The simulator has no separate runtime GC loop, so remove any
		// container records not covered by sandbox removal here.
		for (const container of runningPod.containers) {
			const err = await this.containerRuntime.deleteContainer(ctx, container.id);
			if (err) {
				return err;
			}
		}
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kubelet.go SyncTerminatedPod.
	private async syncTerminatedPod(
		ctx: context.Context,
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
	): Promise<Error | undefined> {
		if (ctx.err()) {
			return context.Canceled;
		}
		const apiPodStatus = this.generateAPIPodStatus(ctx, pod, podStatus, true);
		await this.statusManager.setPodStatus(pod, apiPodStatus);

		// Kubernetes waits for volume teardown, unregisters secret/configmap
		// managers, and releases cgroups/user namespaces here. The simulator does
		// not model those resources, but it does tear down its in-memory CRI pod.
		const cleanupErr = await this.cleanupPodRuntime(ctx, pod);
		if (cleanupErr) {
			return cleanupErr;
		}

		this.statusManager.terminatePod(pod);
		return undefined;
	}

	private async cleanupPodRuntime(ctx: context.Context, pod: V1Pod): Promise<Error | undefined> {
		let runningPod: RuntimePod;
		try {
			runningPod = await this.getRuntimePod(ctx, pod);
		} catch (error) {
			return error instanceof Error ? error : new Error(String(error));
		}
		if (this.runtimeService) {
			for (const sandbox of runningPod.sandboxes) {
				const err = await this.runtimeService.removePodSandbox(ctx, sandbox.id.id);
				if (err) {
					return err;
				}
			}
		}
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kubelet.go SyncTerminatingPod runtime pod lookup.
	private async getRuntimePod(ctx: context.Context, pod: V1Pod): Promise<RuntimePod> {
		const [runtimePod, err] = await this.containerRuntime.getPod(ctx, pod.metadata?.uid ?? "");
		if (err) {
			if (err.message !== "pod sandboxes not found") {
				throw err;
			}
		}
		if (runtimePod) {
			return runtimePod;
		}
		return this.emptyRuntimePod(pod);
	}

	// Models kubernetes/pkg/kubelet/kubelet.go SyncTerminatingPod ErrPodNotFound fallback.
	private emptyRuntimePod(pod: V1Pod): RuntimePod {
		return {
			id: pod.metadata?.uid ?? "",
			name: pod.metadata?.name ?? "",
			namespace: pod.metadata?.namespace ?? "default",
			createdAt: 0,
			timestamp: this.clock.now(),
			containers: [],
			sandboxes: [],
		};
	}

	// Models kubernetes/pkg/kubelet/kubelet.go cleanUpContainersInPod.
	private async cleanUpContainersInPod(
		ctx: context.Context,
		podID: string,
		exitedContainerID: string,
	): Promise<void> {
		const [podStatus, podStatusErr] = await this.podCache.get(podID);
		if (podStatusErr || !podStatus) {
			return;
		}
		for (const container of getContainersToDeleteInPod(exitedContainerID, podStatus, 1)) {
			await this.containerRuntime.deleteContainer(ctx, container.id);
		}
	}
}
