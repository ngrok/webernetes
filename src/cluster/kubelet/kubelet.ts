import type {
	V1Container,
	V1ContainerStatus,
	V1Node,
	V1NodeAddress,
	V1Pod,
	V1PodStatus,
	V1Service,
} from "../../client";
import { Channel, select, type ReadOnlyChannel } from "../../go/channel";
import * as context from "../../go/context";
import { formatIP } from "../../go/net";
import { Mutex } from "../../go/sync/mutex";
import * as time from "../../go/time";
import * as expansion from "../../third_party/forked/golang/expansion";
import type { Backoff } from "../../client-go/util/flowcontrol/backoff";
import { newBackOff } from "../../client-go/util/flowcontrol/backoff";
import type { DnsConfig, ImageManagerService, RuntimeService } from "../cri";
import {
	allContainersCouldRestart,
	containerShouldRestart,
	isPodPhaseTerminal,
} from "../api/v1/pod/util";
import {
	convertPodStatusToRunningPod,
	errPodNotFound,
	findContainerByName,
	findPod,
	isHostNetworkPod,
	newContainerGC,
	newRuntimeCache,
	networkReady,
	PodStatusCache,
	runtimeReady,
	type Runtime,
	toAPIPod,
} from "./container";
import type {
	CommandRunner,
	Container,
	EnvVar,
	Pod as RuntimePod,
	PodStatus as PodRuntimeStatus,
	Runtime as KubeletRuntime,
	RuntimeCache,
	GC,
	Status as ContainerStatus,
} from "./container";
import type { RunContainerOptions, RuntimeHelper } from "./container";
import { PodManager } from "./pod";
import { ProbeManagerImpl, ResultsManager } from "./prober";
import type { ProbeManager, ProbeUpdate } from "./prober";
import {
	PodWorkersImpl,
	type PodWorkers,
	type PodWorkerSync,
	type SyncPodResult,
} from "./pod-workers";
import type { EventRecorder } from "../../client-go/tools/record/event";
import { StatusManagerImpl, type PodDeletionSafetyProvider, type StatusManager } from "./status";
import { ContainerDied, ContainerRemoved, GenericPLEG, type PodLifecycleEvent } from "./pleg";
import { networkNotReadyErrorMsg } from "./errors";
import * as podutil from "../api/v1/pod/util";
import { isServiceIPSet } from "../apis/core/v1/helper/helpers";
import { getPodQOS } from "../apis/core/v1/helper/qos/qos";
import { fromServices } from "./envvars";
import { BasicWorkQueue } from "./util/queue/work-queue";
import type { WorkQueue } from "./util/queue/work-queue";
import { apiserverSource, isStaticPod, type PodUpdate, type SyncPodType } from "./types/pod-update";
import * as kubetypes from "./types/pod-status";
import { KubeGenericRuntimeManager } from "./kuberuntime";
import { getPhase, truncatePodHostnameIfNeeded } from "./kubelet-pods";
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
	needToReconcilePodReadiness,
} from "./status";
import { podIsEvicted } from "./eviction";
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
import { newPodContainerDeletor, type PodContainerDeletor } from "./pod-container-deletor";
import type { KubeletConfiguration } from "./apis/config";
import type { KubeClient } from "../cluster";
import type { ClusterNetwork } from "../cni";
import type { Clock } from "../../clock";
import {
	isDNS1123Label,
	isDNS1123Subdomain,
} from "../../apimachinery/pkg/util/validation/validation";
import { getNodeHostIPs } from "../../util/node";
import { isIPv4, isIPv6, parseIPSloppy } from "../../utils/net";
import { untilWithContext } from "../../apimachinery/pkg/util/wait/backoff";

// Models kubernetes/pkg/kubelet/kubelet.go maxWaitForContainerRuntime.
const maxWaitForContainerRuntimeMs = 30 * 1000;
// Models kubernetes/pkg/kubelet/kubelet.go MaxCrashLoopBackOff.
const maxCrashLoopBackOffMs = 300 * 1000;
// Models kubernetes/pkg/kubelet/kubelet.go initialCrashLoopBackOff.
const initialCrashLoopBackOffMs = 10 * 1000;
// Models kubernetes/pkg/kubelet/kubelet.go MaxImageBackOff.
const maxImageBackOffMs = 300 * 1000;
// Models kubernetes/pkg/kubelet/kubelet.go housekeepingPeriod.
const housekeepingPeriodMs = 2 * 1000;
// Models kubernetes/pkg/kubelet/kubelet.go housekeepingWarningDuration.
const housekeepingWarningDurationMs = 1000;
// Models kubernetes/pkg/kubelet/kubelet.go runtimeCacheRefreshPeriod.
const runtimeCacheRefreshPeriodMs = housekeepingPeriodMs + housekeepingWarningDurationMs;
// Models kubernetes/pkg/kubelet/kubelet.go backOffPeriod.
const backOffPeriodMs = 10 * 1000;
// Models kubernetes/pkg/kubelet/kubelet.go imageBackOffPeriod.
const imageBackOffPeriodMs = 10 * 1000;
// Models kubernetes/pkg/kubelet/kubelet.go ContainerGCPeriod.
const containerGCPeriodMs = 60 * 1000;
// Models kubernetes/pkg/kubelet/kubelet.go minDeadContainerInPod.
const minDeadContainerInPod = 1;
// Models kubernetes/pkg/kubelet/kubelet.go syncLoop's one-second syncTicker.
const syncTickerPeriodMs = 1000;
// Models kubernetes/pkg/kubelet/kubelet.go Run's updateRuntimeUp interval.
const runtimeStatusUpdatePeriodMs = 5 * 1000;
// Models kubernetes/pkg/kubelet/kubelet.go SyncHandler.
export interface SyncHandler {
	handlePodAdditions(ctx: context.Context, pods: V1Pod[]): Promise<void>;
	handlePodUpdates(ctx: context.Context, pods: V1Pod[]): Promise<void>;
	handlePodRemoves(ctx: context.Context, pods: V1Pod[]): Promise<void>;
	handlePodReconcile(ctx: context.Context, pods: V1Pod[]): Promise<void>;
	handlePodSyncs(ctx: context.Context, pods: V1Pod[]): Promise<void>;
	handlePodCleanups(ctx: context.Context): Promise<Error | undefined>;
}

// Models kubernetes/pkg/kubelet/kubelet.go Dependencies.
export interface KubeletDependencies {
	kubeClient: KubeClient | undefined;
	podConfig?: PodConfig;
	recorder: EventRecorder;
	remoteRuntimeService?: RuntimeService;
	remoteImageService?: ImageManagerService;
	podStartupLatencyTracker: PodStartupSLIObserver;

	// Simulator-only dependencies.
	clock: Clock;
	network: ClusterNetwork;
	node: V1Node;
}

interface KubeletOptions {
	ctx: context.Context;
	cancelContext: context.CancelFunc;
	hostname: string;
	nodeName: string;
	kubeClient: KubeClient;
	resyncIntervalMs: number;
	dnsConfigurer: Configurer;
	serviceLister: ServiceLister | undefined;
	serviceHasSynced: () => boolean;
	nodeLister: NodeLister;
	nodeHasSynced: () => boolean;
	cachedNode: V1Node | undefined;
	podConfig: PodConfig;
	sourcesReady: SourcesReady;
	runtimeService: RuntimeService | undefined;
	imageService: ImageManagerService | undefined;
	containerRuntime?: KubeletRuntime;
	runtimeCache?: RuntimeCache;
	runtimeState: RuntimeState;
	runner?: CommandRunner;
	podManager: PodManager;
	probeManager?: ProbeManager;
	livenessManager: ResultsManager;
	readinessManager: ResultsManager;
	startupManager: ResultsManager;
	podWorkers?: PodWorkers & { close(): Promise<void> };
	podCache: PodStatusCache;
	pleg?: GenericPLEG;
	statusManager?: StatusManager;
	recorder: EventRecorder;
	workQueue: WorkQueue;
	crashLoopBackOff: Backoff;
	clock: Clock;
	nodeIPs: string[];
	nodeAddresses: V1NodeAddress[] | undefined;
}

const masterServices = new Set(["kubernetes"]);

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
	if (kubeDeps.kubeClient) {
		newSourceApiserver(
			ctx,
			new PodListWatchClient(kubeDeps.kubeClient.kubeConfig),
			nodeName,
			nodeHasSynced,
			cfg.channel(ctx, apiserverSource),
			clock,
		);
	} else {
		// For now we will throw an error here to make it easier to identify
		// when things are not configured correctly.
		throw new Error("kubeClient is required");
	}

	return [cfg, undefined];
}

export class NoopPodStartupSLIObserver implements PodStartupSLIObserver {
	observedPodOnWatch(_pod: V1Pod, _when: Date): void {}
	recordStatusUpdated(_pod: V1Pod): void {}
	deletePodStartupState(_podUid: string): void {}
}

// Models kubernetes/pkg/kubelet/kubelet.go NewMainKubelet.
export function newMainKubelet(
	ctx: context.Context,
	kubeCfg: KubeletConfiguration,
	kubeDeps: KubeletDependencies,
	hostname: string,
	nodeName: string,
	nodeIPs: string[],
): Kubelet {
	if (!kubeDeps.kubeClient) {
		throw new Error("standalone kubelet mode is not implemented");
	}
	const kubeClient = kubeDeps.kubeClient;
	const nodeLister = newAPINodeLister(kubeClient);
	const nodeHasSynced = () => true;
	if (!kubeDeps.podConfig) {
		const [podConfig, podConfigErr] = makePodSourceConfig(
			ctx,
			kubeCfg,
			kubeDeps,
			nodeName,
			nodeHasSynced,
			kubeDeps.clock,
		);
		if (podConfigErr) {
			throw podConfigErr;
		}
		kubeDeps.podConfig = podConfig;
	}
	const podConfig = kubeDeps.podConfig;
	const serviceLister = newAPIServiceLister(kubeClient);
	const serviceHasSynced = () => true;
	const normalizedNodeIPs = [...nodeIPs];
	const clusterDNS = kubeCfg.clusterDNS.flatMap((ipEntry) => {
		const ip = parseIPSloppy(ipEntry);
		return ip ? [formatIP(ip)] : [];
	});
	const dnsConfigurer = new Configurer({
		recorder: kubeDeps.recorder,
		nodeRef: {
			kind: "Node",
			name: nodeName,
			uid: nodeName,
			namespace: "",
		},
		nodeIPs: normalizedNodeIPs,
		clusterDNS,
		clusterDomain: kubeCfg.clusterDomain,
		resolverConfig: "",
	});
	const [kubeletCtx, cancelContext] = context.withCancel(ctx);
	if (!kubeDeps.remoteRuntimeService || !kubeDeps.remoteImageService) {
		throw new Error("remote runtime and image services are required");
	}
	const podManager = new PodManager();
	const livenessManager = new ResultsManager();
	const readinessManager = new ResultsManager();
	const startupManager = new ResultsManager();
	const runtimeState = newRuntimeState(maxWaitForContainerRuntimeMs, kubeDeps.clock);
	const workQueue = new BasicWorkQueue(kubeDeps.clock);
	const podCache = new PodStatusCache();
	const kubelet = new Kubelet({
		ctx: kubeletCtx,
		cancelContext,
		hostname,
		nodeName,
		kubeClient,
		resyncIntervalMs: kubeCfg.syncFrequencyMs,
		dnsConfigurer,
		serviceLister,
		serviceHasSynced,
		nodeLister,
		nodeHasSynced,
		cachedNode: kubeDeps.node,
		podConfig,
		sourcesReady: newSourcesReady(podConfig.seenAllSources.bind(podConfig)),
		runtimeService: kubeDeps.remoteRuntimeService,
		imageService: kubeDeps.remoteImageService,
		runtimeState,
		podManager,
		livenessManager,
		readinessManager,
		startupManager,
		podCache,
		recorder: kubeDeps.recorder,
		workQueue,
		crashLoopBackOff: newBackOff(initialCrashLoopBackOffMs, maxCrashLoopBackOffMs, kubeDeps.clock),
		clock: kubeDeps.clock,
		nodeIPs: normalizedNodeIPs,
		nodeAddresses: kubeDeps.node.status?.addresses,
	});
	kubelet.statusManager = new StatusManagerImpl({
		clock: kubeDeps.clock,
		kubeClient,
		podManager,
		podDeletionSafety: kubelet,
		podStartupLatencyHelper: kubeDeps.podStartupLatencyTracker,
	});
	kubelet.podWorkers = new PodWorkersImpl(
		kubeDeps.clock,
		kubelet.workQueue,
		kubeCfg.syncFrequencyMs,
		backOffPeriodMs,
		kubelet,
		kubelet.podCache,
	);
	const containerRuntime = new KubeGenericRuntimeManager({
		ctx: kubeletCtx,
		runtimeService: kubeDeps.remoteRuntimeService,
		imageService: kubeDeps.remoteImageService,
		podStateProvider: kubelet.podWorkers,
		runtimeHelper: kubelet,
		events: kubeDeps.recorder,
		livenessManager,
		imageBackOff: newBackOff(imageBackOffPeriodMs, maxImageBackOffMs, kubeDeps.clock),
		registryPullQPS: kubeCfg.registryPullQPS,
		registryBurst: kubeCfg.registryBurst,
		maxParallelImagePulls: kubeCfg.serializeImagePulls ? 1 : kubeCfg.maxParallelImagePulls,
		network: kubeDeps.network,
		startupManager,
		clock: kubeDeps.clock,
	});
	kubelet.containerRuntime = containerRuntime;
	const containerGCPolicy = {
		minAgeMs: kubeCfg.minimumGCAgeMs,
		maxPerPodContainer: kubeCfg.maxPerPodContainerCount,
		maxContainers: kubeCfg.maxContainerCount,
	};
	const [containerGC, containerGCErr] = newContainerGC(
		kubelet.containerRuntime,
		containerGCPolicy,
		kubelet.sourcesReady,
	);
	if (containerGCErr || !containerGC) {
		throw containerGCErr ?? new Error("failed to initialize container garbage collector");
	}
	kubelet.containerGC = containerGC;
	kubelet.containerDeletor = newPodContainerDeletor(
		kubeletCtx,
		kubelet.containerRuntime,
		Math.max(containerGCPolicy.maxPerPodContainer, minDeadContainerInPod),
		kubeDeps.clock,
	);
	kubelet.runtimeCache = newRuntimeCache(
		kubelet.containerRuntime,
		runtimeCacheRefreshPeriodMs,
		kubeDeps.clock,
	);
	kubelet.runner = containerRuntime;
	kubelet.probeManager = new ProbeManagerImpl(
		kubeletCtx,
		kubelet.statusManager,
		livenessManager,
		readinessManager,
		startupManager,
		kubelet.runner,
		kubeDeps.recorder,
		kubeDeps.clock,
		kubeDeps.network,
	);
	kubelet.pleg = new GenericPLEG(
		kubelet.containerRuntime,
		new Channel<PodLifecycleEvent>(100),
		{
			relistPeriodMs: 1000,
			relistThresholdMs: 3 * 60 * 1000,
		},
		kubelet.podCache,
		kubeDeps.clock,
		kubeletCtx,
	);
	runtimeState.addHealthCheck("PLEG", () => {
		const health = kubelet.pleg.healthy();
		return [health.ok, health.error];
	});
	const [activeDeadlineHandler, activeDeadlineHandlerErr] = newActiveDeadlineHandler(
		kubelet.statusManager,
		kubelet.recorder,
		kubelet.clock,
	);
	if (activeDeadlineHandlerErr) {
		throw activeDeadlineHandlerErr;
	}
	if (activeDeadlineHandler) {
		kubelet.addPodSyncLoopHandler(activeDeadlineHandler);
		kubelet.addPodSyncHandler(activeDeadlineHandler);
	}
	return kubelet;
}

// Models kubernetes/pkg/kubelet/kubelet.go serviceLister.
export interface ServiceLister {
	list(): Promise<[services: V1Service[], err: Error | undefined]>;
}

// Models kubernetes/pkg/kubelet/kubelet.go nodeLister.
export interface NodeLister {
	get(name: string): Promise<[node: V1Node | undefined, err: Error | undefined]>;
	list(): Promise<[nodes: V1Node[], err: Error | undefined]>;
}

function newAPIServiceLister(kubeClient: KubeClient): ServiceLister {
	return {
		async list() {
			try {
				const services = await kubeClient.corev1.listServiceForAllNamespaces();
				return [services.items, undefined];
			} catch (error) {
				return [[], error instanceof Error ? error : new Error(String(error))];
			}
		},
	};
}

function newAPINodeLister(kubeClient: KubeClient): NodeLister {
	return {
		async get(name) {
			try {
				const node = await kubeClient.corev1.readNode({ name });
				return [node, undefined];
			} catch (error) {
				return [undefined, error instanceof Error ? error : new Error(String(error))];
			}
		},
		async list() {
			try {
				const nodes = await kubeClient.corev1.listNode();
				return [nodes.items, undefined];
			} catch (error) {
				return [[], error instanceof Error ? error : new Error(String(error))];
			}
		},
	};
}

// Models kubernetes/pkg/kubelet/kubelet.go Kubelet.
export class Kubelet implements RuntimeHelper, PodDeletionSafetyProvider {
	private readonly hostname: string;
	private readonly nodeName: string;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	readonly clock: Clock;
	private readonly kubeClient: KubeClient;
	private readonly resyncIntervalMs: number;
	private readonly dnsConfigurer: Configurer;
	// Package-visible for upstream-parity tests that mirror kubelet_pods_test.go.
	serviceLister: ServiceLister | undefined;
	// Package-visible for upstream-parity tests that mirror kubelet_pods_test.go.
	serviceHasSynced: () => boolean;
	// Package-visible for upstream-parity tests that mirror kubelet_getters.go.
	nodeLister: NodeLister;
	// Package-visible for upstream-parity tests that mirror kubelet.go.
	nodeHasSynced: () => boolean;
	cachedNode: V1Node | undefined;
	private readonly podConfig: PodConfig;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	sourcesReady: SourcesReady;
	// Package-visible for Cluster fake exec adapter.
	readonly runtimeService: RuntimeService | undefined;
	private readonly imageService: ImageManagerService | undefined;
	// Package-visible for upstream-parity tests and Server wiring that mirror kubelet_test.go.
	containerRuntime!: KubeletRuntime;
	// Models kubernetes/pkg/kubelet/kubelet.go Kubelet.containerGC.
	containerGC!: GC;
	// Models kubernetes/pkg/kubelet/kubelet.go Kubelet.containerDeletor.
	containerDeletor!: PodContainerDeletor;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	runtimeCache!: RuntimeCache;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	readonly runtimeState: RuntimeState;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	runner!: CommandRunner;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	readonly podManager: PodManager;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	probeManager!: ProbeManager;
	private readonly livenessManager: ResultsManager;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	readonly readinessManager: ResultsManager;
	private readonly startupManager: ResultsManager;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	podWorkers!: PodWorkers & { close(): Promise<void> };
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	readonly podCache = new PodStatusCache();
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	pleg!: GenericPLEG;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	statusManager!: StatusManager;
	// Package-visible for upstream-parity tests that mirror kubelet_pods_test.go.
	recorder: EventRecorder;
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	readonly workQueue: WorkQueue;
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
	// Package-visible for upstream-parity tests that mirror kubelet_pods_test.go.
	nodeAddresses: V1NodeAddress[] | undefined;
	private readonly ctx: context.Context;
	private readonly cancelContext: context.CancelFunc;
	private syncLoopPromise: Promise<void> | undefined;
	private statusManagerPromise: Promise<void> | undefined;
	private runtimeStatusUpdaterPromise: Promise<void> | undefined;
	private containerGCPromise: Promise<void> | undefined;
	private readonly updateRuntimeMux = new Mutex();
	private closePromise: Promise<void> | undefined;
	private syncLoopExited = false;

	public constructor(options: KubeletOptions) {
		this.hostname = options.hostname;
		this.nodeName = options.nodeName;
		this.kubeClient = options.kubeClient;
		this.resyncIntervalMs = options.resyncIntervalMs;
		this.dnsConfigurer = options.dnsConfigurer;
		this.serviceLister = options.serviceLister;
		this.serviceHasSynced = options.serviceHasSynced;
		this.nodeIPs = [...options.nodeIPs];
		this.cachedNode = options.cachedNode;
		this.nodeLister = options.nodeLister;
		this.nodeHasSynced = options.nodeHasSynced;
		this.podConfig = options.podConfig;
		this.nodeAddresses = options.nodeAddresses;
		this.sourcesReady = options.sourcesReady;
		this.clock = options.clock;
		this.ctx = options.ctx;
		this.cancelContext = options.cancelContext;
		this.runtimeService = options.runtimeService;
		this.imageService = options.imageService;
		this.podManager = options.podManager;
		this.recorder = options.recorder;
		if (options.statusManager) {
			this.statusManager = options.statusManager;
		}
		this.livenessManager = options.livenessManager;
		this.readinessManager = options.readinessManager;
		this.startupManager = options.startupManager;
		this.crashLoopBackOff = options.crashLoopBackOff;
		if (options.containerRuntime) {
			this.containerRuntime = options.containerRuntime;
		}
		if (options.runtimeCache) {
			this.runtimeCache = options.runtimeCache;
		}
		this.runtimeState = options.runtimeState;
		if (options.runner) {
			this.runner = options.runner;
		}
		if (options.probeManager) {
			this.probeManager = options.probeManager;
		}
		this.workQueue = options.workQueue;
		this.podCache = options.podCache;
		if (options.pleg) {
			this.pleg = options.pleg;
		}
		if (options.podWorkers) {
			this.podWorkers = options.podWorkers;
		}
	}

	// Models kubernetes/pkg/kubelet/kubelet.go PodCPUAndMemoryStats.
	podCPUAndMemoryStats(
		_ctx: context.Context,
		_pod: V1Pod,
		_podStatus: PodRuntimeStatus,
	): [podStats: undefined, err: undefined] {
		return [undefined, undefined];
	}

	// Models kubernetes/pkg/kubelet/lifecycle/interfaces.go PodSyncLoopHandlers.AddPodSyncLoopHandler.
	addPodSyncLoopHandler(a: PodSyncLoopHandler): void {
		this.podSyncLoopHandlers.addPodSyncLoopHandler(a);
	}

	// Models kubernetes/pkg/kubelet/lifecycle/interfaces.go PodSyncHandlers.AddPodSyncHandler.
	addPodSyncHandler(a: PodSyncHandler): void {
		this.podSyncHandlers.addPodSyncHandler(a);
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go PodCouldHaveRunningContainers.
	async podCouldHaveRunningContainers(pod: V1Pod): Promise<boolean> {
		if (await this.podWorkers.couldHaveRunningContainers(pod.metadata?.uid ?? "")) {
			return true;
		}

		// Dynamic resource unprepare checks are intentionally omitted: the simulator
		// does not currently model Kubernetes resource allocation managers.
		return false;
	}

	// Models kubernetes/pkg/kubelet/kubelet.go Run.
	async run(): Promise<void> {
		await this.updateRuntimeUp(this.ctx);

		// Models kubernetes/pkg/kubelet/kubelet.go Run's wait.UntilWithContext updateRuntimeUp loop.
		this.runtimeStatusUpdaterPromise = untilWithContext(
			this.ctx,
			(ctx) => this.updateRuntimeUp(ctx),
			runtimeStatusUpdatePeriodMs,
			this.clock,
		);
		this.statusManagerPromise = this.statusManager.start(this.ctx);
		await this.pleg.start();
		this.syncLoopPromise = this.syncLoop(this.ctx, this.podConfig.updates(), this);
	}

	// Models kubernetes/pkg/kubelet/kubelet.go StartGarbageCollection.
	startGarbageCollection(ctx: context.Context): void {
		this.containerGCPromise = untilWithContext(
			ctx,
			async (ctx) => {
				const err = await this.containerGC.garbageCollect(ctx);
				if (err) {
					await this.recorder.eventf(
						{
							kind: "Node",
							name: this.nodeName,
							uid: this.nodeName,
							namespace: "",
						},
						"Warning",
						"ContainerGCFailed",
						"%s",
						err.message,
					);
				}
			},
			containerGCPeriodMs,
			this.clock,
		);

		// TODO(samwho): implement image GC here
	}

	close(): Promise<void> {
		if (!this.closePromise) {
			this.cancelContext();
			this.closePromise = (async () => {
				await this.pleg.stop();
				await this.podCache.updateTime(this.clock.now());
				if (this.probeManager instanceof ProbeManagerImpl) {
					await this.probeManager.close();
				}
				await this.podWorkers.close();
				await this.syncLoopPromise;
				await this.runtimeStatusUpdaterPromise;
				await this.statusManagerPromise;
				await this.containerGCPromise;
			})();
		}
		return this.closePromise;
	}

	// Models kubernetes/pkg/kubelet/kubelet.go updateRuntimeUp.
	async updateRuntimeUp(ctx: context.Context): Promise<void> {
		await this.updateRuntimeMux.withLock(async () => {
			const [status, statusErr] = await this.containerRuntime.status(ctx);
			if (statusErr || !status) {
				return;
			}

			const networkReadyCondition = status.getRuntimeCondition(networkReady);
			if (!networkReadyCondition?.status) {
				this.runtimeState.setNetworkState(
					new Error(`container runtime network not ready: ${String(networkReadyCondition)}`),
				);
			} else {
				this.runtimeState.setNetworkState(undefined);
			}

			const runtimeReadyCondition = status.getRuntimeCondition(runtimeReady);
			if (!runtimeReadyCondition?.status) {
				this.runtimeState.setRuntimeState(
					new Error(`container runtime not ready: ${String(runtimeReadyCondition)}`),
				);
				return;
			}

			this.runtimeState.setRuntimeState(undefined);
			this.runtimeState.setRuntimeHandlers(status.handlers);
			this.runtimeState.setRuntimeFeatures(status.features);
			this.runtimeState.setRuntimeSync(this.clock.now());
		});
	}

	// Test observability hook used by cluster shutdown tests.
	isSyncLoopExited(): boolean {
		return this.syncLoopExited;
	}

	// Test observability hook used to assert probe workers are cleaned up.
	probeWorkerCount(): number {
		if (this.probeManager instanceof ProbeManagerImpl) {
			return this.probeManager.workerCount();
		}
		return 0;
	}

	// Models kubernetes/pkg/kubelet/kubelet_getters.go Kubelet.getRuntime.
	private getRuntime(): Runtime {
		return this.containerRuntime;
	}

	// Models kubernetes/pkg/kubelet/kubelet.go SyncPod.
	async syncPod(
		ctx: context.Context,
		updateType: SyncPodType,
		pod: V1Pod | undefined,
		mirrorPod: V1Pod | undefined,
		podStatus: PodRuntimeStatus,
	): Promise<SyncPodResult> {
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

		if (apiPodStatus.phase === "Succeeded" || apiPodStatus.phase === "Failed") {
			await this.statusManager.setPodStatus(pod, apiPodStatus);
			return [true, undefined, undefined];
		}

		await this.statusManager.setPodStatus(pod, apiPodStatus);

		const networkErr = this.runtimeState.networkErrors();
		if (networkErr && !isHostNetworkPod(pod)) {
			await this.recorder.eventf(
				pod,
				"Warning",
				"NetworkNotReady",
				"%s: %s",
				networkNotReadyErrorMsg,
				networkErr.message,
			);
			return [
				false,
				undefined,
				new Error(`${networkNotReadyErrorMsg}: ${networkErr.message}`, {
					cause: networkErr,
				}),
			];
		}

		// Kubernetes registers referenced secrets and configmaps here. The
		// simulator keeps image credential and configmap/secret resolution out
		// of kubelet sync scope for now.

		// Kubernetes creates and updates pod cgroups/QOS hierarchy here. The
		// simulator does not model cgroups, resource requests, or limits.

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
		let restartingAllContainers = false;
		for (const cond of apiPodStatus.conditions ?? []) {
			if (cond.type === "AllContainersRestarting" && cond.status === "True") {
				restartingAllContainers = true;
			}
		}
		const result = await this.containerRuntime.syncPod(
			ctx,
			pod,
			podStatus,
			pullSecrets,
			this.crashLoopBackOff,
			restartingAllContainers,
		);
		this.reasonCache.update(pod.metadata?.uid ?? "", result);
		if (restartingAllContainers && !result.error()) {
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
		const err = result.error();
		let postSync: (() => void) | undefined;
		if (result.syncResults.length > 0 && !err) {
			postSync = () => this.requestPodRelist(pod.metadata?.uid ?? "");
		}
		return [false, postSync, err];
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

		const p = convertPodStatusToRunningPod(this.getRuntime().type(), podStatus);
		const killErr = await this.killPod(ctx, pod, p, gracePeriod);
		if (killErr) {
			return new Error(`error killing terminating pod: ${killErr.message}`, {
				cause: killErr,
			});
		}

		this.probeManager.removePod(pod);

		let [runtimePod, runtimePodErr] = await this.containerRuntime.getPod(
			ctx,
			pod.metadata?.uid ?? "",
		);
		if (runtimePodErr) {
			if (runtimePodErr === errPodNotFound) {
				runtimePod = {
					id: pod.metadata?.uid ?? "",
					name: pod.metadata?.name ?? "",
					namespace: pod.metadata?.namespace ?? "default",
					createdAt: 0,
					timestamp: this.clock.now(),
					containers: [],
					sandboxes: [],
				};
			} else {
				return new Error(
					`unable to get pod prior to final pod termination: ${runtimePodErr.message}`,
					{
						cause: runtimePodErr,
					},
				);
			}
		}
		if (!runtimePod) {
			runtimePod = {
				id: pod.metadata?.uid ?? "",
				name: pod.metadata?.name ?? "",
				namespace: pod.metadata?.namespace ?? "default",
				createdAt: 0,
				timestamp: this.clock.now(),
				containers: [],
				sandboxes: [],
			};
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
	async syncTerminatingRuntimePod(
		ctx: context.Context,
		runningPod: RuntimePod,
	): Promise<Error | undefined> {
		const pod = toAPIPod(runningPod);
		const gracePeriod = 1;
		const killErr = await this.killPod(ctx, pod, runningPod, gracePeriod);
		if (killErr) {
			return killErr;
		}
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kubelet.go SyncTerminatedPod.
	async syncTerminatedPod(
		ctx: context.Context,
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
	): Promise<Error | undefined> {
		const apiPodStatus = this.generateAPIPodStatus(ctx, pod, podStatus, true);
		await this.statusManager.setPodStatus(pod, apiPodStatus);

		await this.statusManager.terminatePod(pod);
		return undefined;
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

	// Models kubernetes/pkg/kubelet/kubelet.go syncLoop.
	async syncLoop(
		ctx: context.Context,
		updates: ReadOnlyChannel<PodUpdate>,
		handler: SyncHandler,
	): Promise<void> {
		const syncTicker = new time.Ticker(this.clock, syncTickerPeriodMs);
		const housekeepingTicker = new time.Ticker(this.clock, housekeepingPeriodMs);
		const plegCh = this.pleg.watch();
		const base = 100;
		const max = 5 * 1000;
		const factor = 2;
		let duration = base;
		try {
			while (!ctx.err()) {
				const err = this.runtimeState.runtimeErrors();
				if (err) {
					const selected = await select()
						.case(ctx.done(), () => "done")
						.case(time.after(this.clock, duration), () => "timeout");
					if (selected === "done") {
						break;
					}
					duration = Math.min(max, factor * duration);
					continue;
				}
				duration = base;

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
				switch (value.op) {
					case "ADD":
						await handler.handlePodAdditions(ctx, value.pods);
						break;
					case "UPDATE":
						await handler.handlePodUpdates(ctx, value.pods);
						break;
					case "REMOVE":
						await handler.handlePodRemoves(ctx, value.pods);
						break;
					case "RECONCILE":
						await handler.handlePodReconcile(ctx, value.pods);
						break;
					case "DELETE":
						await handler.handlePodUpdates(ctx, value.pods);
						break;
				}
				this.sourcesReady.addSource(value.source);
				return true;
			})
			.case(plegCh, async ({ ok, value }) => {
				if (ok) {
					if (isSyncPodWorthy(value)) {
						const pod = this.podManager.getPodByUid(value.id);
						if (pod) {
							await handler.handlePodSyncs(ctx, [pod]);
						}
					}
					if (value.type === ContainerDied && value.data) {
						await this.cleanUpContainersInPod(ctx, value.id, value.data);
					}
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
					await handleProbeSync(ctx, this, value, handler, "liveness", "unhealthy");
				}
				return true;
			})
			.case(this.readinessManager.updates(), async ({ ok, value }) => {
				if (ok) {
					const ready = value.result === "success";
					await this.statusManager.setContainerReadiness(value.podUid, value.containerId, ready);

					const status = ready ? "ready" : "not ready";
					await handleProbeSync(ctx, this, value, handler, "readiness", status);
				}
				return true;
			})
			.case(this.startupManager.updates(), async ({ ok, value }) => {
				if (ok) {
					const started = value.result === "success";
					await this.statusManager.setContainerStartup(value.podUid, value.containerId, started);

					const status = started ? "started" : "unhealthy";
					await handleProbeSync(ctx, this, value, handler, "startup", status);
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

	private containerManagerUpdates(): ReadOnlyChannel<{ podUIDs: string[] }> | undefined {
		// Kubernetes' kubelet container manager owns node/pod resource management
		// such as cgroups, QoS hierarchy, device manager, CPU/memory manager, and
		// DRA resource updates. The simulator does not currently model pod
		// resources, limits, cgroups, or dynamic resource allocation, so this
		// mirrors the upstream stub's nil update channel.
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kubelet.go HandlePodAdditions.
	async handlePodAdditions(ctx: context.Context, pods: V1Pod[]): Promise<void> {
		const start = this.clock.now();
		pods.sort(
			(a, b) =>
				(a.metadata?.creationTimestamp?.getTime() ?? 0) -
				(b.metadata?.creationTimestamp?.getTime() ?? 0),
		);
		for (const pod of pods) {
			// Always add the pod to the pod manager. Kubelet relies on the pod
			// manager as the source of truth for the desired state.
			this.podManager.addPod(pod);
			const [resolvedPod, mirrorPod, wasMirror] = this.podManager.getPodAndMirrorPod(pod);
			if (wasMirror) {
				if (!resolvedPod) {
					continue;
				}
				await this.podWorkers.updatePod(ctx, {
					pod: resolvedPod,
					mirrorPod,
					updateType: "update",
					startTime: start,
				});
				continue;
			}
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
			// Upstream uses oldPod in some vertical scaling code paths that we don't
			// have.
			const _oldPod = this.podManager.getPodByUid(pod.metadata?.uid ?? "");
			this.podManager.updatePod(pod);
			const [resolvedPod, mirrorPod, wasMirror] = this.podManager.getPodAndMirrorPod(pod);
			if (wasMirror && !resolvedPod) {
				continue;
			}
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
		for (const pod of pods) {
			this.podManager.removePod(pod);
			// Kubernetes forgets pod certificates and allocation manager state here.
			// Those subsystems are outside the simulator's current scope.
			const [resolvedPod, mirrorPod, wasMirror] = this.podManager.getPodAndMirrorPod(pod);
			if (wasMirror) {
				if (!resolvedPod) {
					continue;
				}
				await this.podWorkers.updatePod(ctx, {
					pod: resolvedPod,
					mirrorPod,
					updateType: "update",
					startTime: start,
				});
				continue;
			}

			await this.deletePod(ctx, pod);
		}

		// Kubernetes retries pending resizes after pod removal. The simulator does
		// not model resource allocation or in-place pod vertical scaling.
	}

	// Models kubernetes/pkg/kubelet/kubelet.go HandlePodReconcile.
	async handlePodReconcile(ctx: context.Context, pods: V1Pod[]): Promise<void> {
		const start = this.clock.now();
		for (const pod of pods) {
			const _oldPod = this.podManager.getPodByUid(pod.metadata?.uid ?? "");
			this.podManager.updatePod(pod);
			const [resolvedPod, mirrorPod, wasMirror] = this.podManager.getPodAndMirrorPod(pod);
			if (wasMirror && !resolvedPod) {
				continue;
			}
			if (!resolvedPod) {
				continue;
			}

			if (needToReconcilePodReadiness(resolvedPod)) {
				await this.podWorkers.updatePod(ctx, {
					pod: resolvedPod,
					mirrorPod,
					updateType: "sync",
					startTime: start,
				});
			}

			if (podIsEvicted(resolvedPod.status)) {
				const [podStatus, podStatusErr] = await this.podCache.get(resolvedPod.metadata?.uid ?? "");
				if (!podStatusErr && podStatus) {
					this.containerDeletor.deleteContainersInPod("", podStatus, true);
				}
			}
		}

		// Kubernetes retries pending resizes here when in-place pod vertical
		// scaling is enabled. The simulator does not model allocationManager
		// resize state.
	}

	// Models kubernetes/pkg/kubelet/kubelet.go HandlePodSyncs.
	async handlePodSyncs(ctx: context.Context, pods: V1Pod[]): Promise<void> {
		const start = this.clock.now();
		for (const pod of pods) {
			const [resolvedPod, mirrorPod, wasMirror] = this.podManager.getPodAndMirrorPod(pod);
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

	// Models kubernetes/pkg/kubelet/kubelet.go cleanUpContainersInPod.
	private async cleanUpContainersInPod(
		_ctx: context.Context,
		podID: string,
		exitedContainerID: string,
	): Promise<void> {
		const [podStatus, podStatusErr] = await this.podCache.get(podID);
		if (podStatusErr || !podStatus) {
			return;
		}
		const removeAll = await this.podWorkers.shouldPodContentBeRemoved(podID);
		this.containerDeletor.deleteContainersInPod(exitedContainerID, podStatus, removeAll);
	}

	// Models kubernetes/pkg/kubelet/kubelet.go Kubelet.PrepareDynamicResources.
	prepareDynamicResources(_ctx: context.Context, _pod: V1Pod): undefined {
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kubelet.go Kubelet.UnprepareDynamicResources.
	unprepareDynamicResources(_ctx: context.Context, _pod: V1Pod): undefined {
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kubelet.go Kubelet.RequestPodReinspect.
	requestPodReinspect(podUID: string): void {
		this.pleg.requestReinspect(podUID);
	}

	// Models kubernetes/pkg/kubelet/kubelet.go Kubelet.RequestPodRelist.
	requestPodRelist(podUID: string): void {
		this.pleg.requestRelist(podUID);
	}

	// Models kubernetes/pkg/kubelet/kubelet.go Kubelet.OnPodSandboxReady.
	onPodSandboxReady(_ctx: context.Context, _pod: V1Pod): undefined {
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go HandlePodCleanups.
	async handlePodCleanups(ctx: context.Context): Promise<Error | undefined> {
		const [allPods, _, orphanedMirrorPodFullnames] = this.podManager.getPodsAndMirrorPods();

		// Stop the workers for terminated pods not in the config source
		const workingPods = await this.podWorkers.syncKnownPods(allPods);

		const allPodsByUid = new Set<string>();
		for (const pod of allPods) {
			const uid = pod.metadata?.uid;
			if (uid) {
				allPodsByUid.add(uid);
			}
		}

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
		this.statusManager.removeOrphanedStatuses(allPodsByUid);

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

			const [pod, mirrorPod, wasMirror] = this.podManager.getPodAndMirrorPod(desiredPod);
			if (!pod || wasMirror) {
				continue;
			}
			await this.podWorkers.updatePod(ctx, {
				updateType: "create",
				pod,
				mirrorPod,
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
		if (pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") {
			return true;
		}
		const status = this.statusManager.getPodStatus(pod.metadata?.uid ?? "");
		if (status?.phase === "Succeeded" || status?.phase === "Failed") {
			return true;
		}
		return false;
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go filterTerminalPodsToDelete.
	private filterTerminalPodsToDelete(
		allPods: V1Pod[],
		runningRuntimePods: RuntimePod[],
		workingPods: Map<string, PodWorkerSync>,
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

	// Models kubernetes/pkg/kubelet/kubelet_pods.go Kubelet.findContainer.
	async findContainer(
		ctx: context.Context,
		podFullName: string,
		podUID: string,
		containerName: string,
	): Promise<[container: Container | undefined, err: Error | undefined]> {
		const [runtimePods, err] = await this.containerRuntime.getPods(ctx, false);
		if (err) {
			return [undefined, err];
		}
		podUID = this.podManager.translatePodUid(podUID);
		const pod = findPod(runtimePods, podFullName, podUID);
		return [findContainerByName(pod, containerName), undefined];
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go Kubelet.RunInContainer.
	async runInContainer(
		ctx: context.Context,
		podFullName: string,
		podUID: string,
		containerName: string,
		cmd: string[],
	): Promise<[output: string, err: Error | undefined]> {
		const [container, err] = await this.findContainer(ctx, podFullName, podUID, containerName);
		if (err) {
			return ["", err];
		}
		if (!container) {
			return ["", new Error(`container not found (${JSON.stringify(containerName)})`)];
		}
		// Upstream passes timeout 0. The simulator's command runner treats
		// undefined as no timeout; 0 would time out immediately.
		return await this.runner.runInContainer(ctx, container.id, cmd, undefined);
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go GeneratePodHostNameAndDomain.
	generatePodHostNameAndDomain(
		pod: V1Pod,
	): [hostname: string, hostDomain: string, err: Error | undefined] {
		const clusterDomain = this.dnsConfigurer.clusterDomain;
		const namespace = pod.metadata?.namespace ?? "";
		const podName = pod.metadata?.name ?? "";

		if (pod.spec?.hostnameOverride !== undefined) {
			const hostname = pod.spec.hostnameOverride;
			const validationErrors = isDNS1123Subdomain(hostname);
			if (validationErrors.length !== 0) {
				return [
					"",
					"",
					new Error(
						`pod HostnameOverride "${hostname}" is not a valid DNS subdomain: ${validationErrors.join(";")}`,
					),
				];
			}
			const [truncatedHostname, err] = truncatePodHostnameIfNeeded(podName, hostname);
			if (err) {
				return ["", "", err];
			}
			return [truncatedHostname, "", undefined];
		}

		let hostname = podName;
		if (pod.spec?.hostname && pod.spec.hostname.length > 0) {
			const validationErrors = isDNS1123Label(pod.spec.hostname);
			if (validationErrors.length !== 0) {
				return [
					"",
					"",
					new Error(
						`pod Hostname "${pod.spec.hostname}" is not a valid DNS label: ${validationErrors.join(";")}`,
					),
				];
			}
			hostname = pod.spec.hostname;
		}

		const [resolvedHostname, err] = truncatePodHostnameIfNeeded(podName, hostname);
		if (err) {
			return ["", "", err];
		}
		hostname = resolvedHostname;

		let hostDomain = "";
		if (pod.spec?.subdomain && pod.spec.subdomain.length > 0) {
			const validationErrors = isDNS1123Label(pod.spec.subdomain);
			if (validationErrors.length !== 0) {
				return [
					"",
					"",
					new Error(
						`pod Subdomain "${pod.spec.subdomain}" is not a valid DNS label: ${validationErrors.join(";")}`,
					),
				];
			}
			hostDomain = `${pod.spec.subdomain}.${namespace}.svc.${clusterDomain}`;
		}
		return [hostname, hostDomain, undefined];
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
		const mapping = expansion.mappingFuncFor(tmpEnv, serviceEnv);
		for (const envVar of container.env ?? []) {
			let runtimeVal = envVar.value ?? "";
			if (runtimeVal.length > 0) {
				runtimeVal = expansion.expand(runtimeVal, mapping);
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
		return await this.dnsConfigurer.getPodDNS(ctx, pod);
	}

	getPodCgroupParent(_pod: V1Pod): string {
		return "";
	}

	getPodDir(podUID: string): string {
		return `/pods/${podUID}`;
	}

	private getPodContainerDir(podUID: string, containerName: string): string {
		return `${this.getPodDir(podUID)}/containers/${containerName}`;
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

	// Models kubernetes/pkg/kubelet/kubelet_pods.go generateAPIPodStatus.
	// Package-visible for upstream-parity tests that mirror kubelet_test.go.
	generateAPIPodStatus(
		ctx: context.Context,
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
		podIsTerminal: boolean,
	): V1PodStatus {
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

	// Models kubernetes/pkg/kubelet/kubelet_getters.go GetNode.
	getNode(ctx: context.Context): Promise<[node: V1Node | undefined, err: Error | undefined]> {
		const err = ctx.err();
		if (err) {
			return Promise.resolve([undefined, err]);
		}
		return this.nodeLister.get(this.nodeName);
	}

	// Models kubernetes/pkg/kubelet/kubelet_getters.go getHostIPsAnyWay.
	private getHostIPsAnyWay(ctx: context.Context): [hostIPs: string[], err: Error | undefined] {
		const err = ctx.err();
		if (err) {
			return [[], err];
		}
		if (this.nodeAddresses) {
			return getNodeHostIPs({ status: { addresses: this.nodeAddresses } });
		}
		return getNodeHostIPs({
			status: {
				addresses: this.nodeIPs.map((address) => ({
					type: "InternalIP",
					address,
				})),
			},
		});
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go sortPodIPs.
	sortPodIPs(podIPs: string[]): string[] {
		const ips: string[] = [];
		const appendFirstMatching = (valid: (ip: number[] | undefined) => boolean): void => {
			for (const ipString of podIPs) {
				const ip = parseIPSloppy(ipString);
				if (ip && valid(ip)) {
					ips.push(formatIP(ip));
					break;
				}
			}
		};

		const firstNodeIP = parseIPSloppy(this.nodeIPs[0] ?? "");
		if (!firstNodeIP || isIPv4(firstNodeIP)) {
			appendFirstMatching(isIPv4);
			appendFirstMatching(isIPv6);
		} else {
			appendFirstMatching(isIPv6);
			appendFirstMatching(isIPv4);
		}
		return ips;
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
			waiting: {
				reason: hasInitContainers ? "PodInitializing" : "ContainerCreating",
			},
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

// Models kubernetes/pkg/kubelet/kubelet.go handleProbeSync.
async function handleProbeSync(
	ctx: context.Context,
	kl: Kubelet,
	update: ProbeUpdate,
	handler: SyncHandler,
	_probe: "liveness" | "readiness" | "startup",
	_status: string,
): Promise<void> {
	const pod = kl.podManager.getPodByUid(update.podUid);
	if (!pod) {
		return;
	}
	await handler.handlePodSyncs(ctx, [pod]);
}
