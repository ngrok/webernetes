import type { V1Node, V1Pod, V1PodSpec } from "../../client";
import { KubeConfig } from "../../client";
import { Set as LabelSet } from "../../apimachinery/pkg/labels/labels";
import { Clock } from "../../clock";
import { Channel } from "../../go/channel";
import * as context from "../../go/context";
import { Mutex } from "../../go/sync/mutex";
import { newBackOff } from "../../client-go/util/flowcontrol/backoff";
import { newFakePassiveClock, type FakePassiveClock } from "../../utils/clock/testing/fake-clock";
import { KubeClient } from "../cluster";
import { Etcd } from "../etcd";
import { EventRecorderImpl } from "../events";
import {
	networkReady,
	RuntimeCondition,
	RuntimeStatus,
	runtimeReady,
	type Image,
	PodStatusCache,
	type Pod,
	type PodStatus as PodRuntimeStatus,
	type ROCache,
} from "./container";
import {
	FakeContainerCommandRunner,
	FakeRuntime,
	newFakeCache,
	newFakeRuntimeCache,
} from "./container/testing";
import { newPodConfig, newSourcesReady } from "./config";
import { Kubelet, NoopPodStartupSLIObserver } from "./kubelet";
import { Configurer } from "./network/dns";
import { GenericPLEG, type PodLifecycleEvent } from "./pleg";
import {
	PodWorkersImpl,
	type PodWorkers,
	type PodWorkerSync,
	type SyncPodResult,
	type UpdatePodOptions,
} from "./pod-workers";
import { PodManager } from "./pod";
import { ResultsManager } from "./prober";
import { FakeManager } from "./prober/testing/fake-manager";
import { newRuntimeState } from "./runtime";
import { StatusManagerImpl } from "./status";
import { wait } from "../../promise";
import type { SyncPodType } from "./types/pod-update";
import { BasicWorkQueue, type WorkQueue } from "./util/queue/work-queue";
import { newActiveDeadlineHandler } from "./active-deadline";

const testServiceCIDR = "10.96.0.0/12";
const testNodePortRange = { from: 30000, to: 32767 };
const testKubeletHostname = "127.0.0.1";

export type SyncPodFnType = (
	ctx: context.Context,
	updateType: SyncPodType,
	pod: V1Pod | undefined,
	mirrorPod: V1Pod | undefined,
	podStatus: PodRuntimeStatus,
) => Promise<SyncPodResult>;

// Models kubernetes/pkg/kubelet/kubelet_test.go podWithUIDNameNs.
export function podWithUIDNameNs(uid: string, name: string, namespace: string): V1Pod {
	return {
		metadata: {
			uid,
			name,
			namespace,
			annotations: {},
		},
	};
}

// Models kubernetes/pkg/kubelet/kubelet_test.go podWithUIDNameNsSpec.
export function podWithUIDNameNsSpec(
	uid: string,
	name: string,
	namespace: string,
	spec: V1PodSpec,
): V1Pod {
	const pod = podWithUIDNameNs(uid, name, namespace);
	pod.spec = spec;
	return pod;
}

// Models kubernetes/pkg/kubelet/kubelet_test.go newTestPods.
export function newTestPods(count: number): V1Pod[] {
	const pods: V1Pod[] = new Array(count);
	for (let i = 0; i < count; i++) {
		pods[i] = {
			spec: {
				containers: [],
				hostNetwork: true,
			},
			metadata: {
				uid: String(10000 + i),
				name: `pod${i}`,
			},
		};
	}
	return pods;
}

// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.
export class FakePodWorkers implements PodWorkers {
	private readonly lock = new Mutex();
	syncPodFn: SyncPodFnType;
	readonly triggeredDeletion: string[] = [];
	readonly triggeredTerminal: string[] = [];
	running = new Map<string, boolean>();
	terminating = new Map<string, boolean>();
	terminated = new Map<string, boolean>();
	terminationRequested = new Map<string, boolean>();
	finished = new Map<string, boolean>();
	removeRuntime = new Map<string, boolean>();
	removeContent = new Map<string, boolean>();
	terminatingStaticPods = new Map<string, boolean>();

	constructor(
		readonly cache: ROCache,
		syncPodFn?: SyncPodFnType,
	) {
		this.syncPodFn = syncPodFn ?? (async () => [false, undefined, undefined]);
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.UpdatePod.
	async updatePod(ctx: context.Context, options: UpdatePodOptions): Promise<void> {
		await this.lock.withLock(async () => {
			let uid: string;
			if (options.pod) {
				uid = options.pod.metadata?.uid ?? "";
			} else if (options.runningPod) {
				uid = options.runningPod.id;
			} else {
				return;
			}
			const [status, err] = await this.cache.get(uid);
			if (err) {
				throw err;
			}
			switch (options.updateType) {
				case "kill":
					this.triggeredDeletion.push(uid);
					break;
				default: {
					if (!status) {
						throw new Error(`pod status cache returned no status for ${uid}`);
					}
					const [isTerminal, , syncErr] = await this.syncPodFn(
						ctx,
						options.updateType,
						options.pod,
						options.mirrorPod,
						status,
					);
					if (syncErr) {
						throw syncErr;
					}
					if (isTerminal) {
						this.triggeredTerminal.push(uid);
					}
				}
			}
		});
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.SyncKnownPods.
	async syncKnownPods(_desiredPods: V1Pod[]): Promise<Map<string, PodWorkerSync>> {
		return new Map<string, PodWorkerSync>();
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.IsPodKnownTerminated.
	async isPodKnownTerminated(uid: string): Promise<boolean> {
		return this.terminated.get(uid) ?? false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.CouldHaveRunningContainers.
	async couldHaveRunningContainers(uid: string): Promise<boolean> {
		return this.running.get(uid) ?? false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.ShouldPodBeFinished.
	async shouldPodBeFinished(uid: string): Promise<boolean> {
		return this.finished.get(uid) ?? false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.IsPodTerminationRequested.
	async isPodTerminationRequested(uid: string): Promise<boolean> {
		return this.terminationRequested.get(uid) ?? false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.ShouldPodContainersBeTerminating.
	async shouldPodContainersBeTerminating(uid: string): Promise<boolean> {
		return this.terminating.get(uid) ?? false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.ShouldPodRuntimeBeRemoved.
	async shouldPodRuntimeBeRemoved(uid: string): Promise<boolean> {
		return this.removeRuntime.get(uid) ?? false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.setPodRuntimeBeRemoved.
	setPodRuntimeBeRemoved(uid: string): void {
		this.removeRuntime.clear();
		this.removeRuntime.set(uid, true);
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.ShouldPodContentBeRemoved.
	async shouldPodContentBeRemoved(uid: string): Promise<boolean> {
		return this.removeContent.get(uid) ?? false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.IsPodForMirrorPodTerminatingByFullName.
	async isPodForMirrorPodTerminatingByFullName(podFullname: string): Promise<boolean> {
		return this.terminatingStaticPods.get(podFullname) ?? false;
	}

	async close(): Promise<void> {}
}

export interface FakeQueueItem {
	uid: string;
	delay: number;
}

// Models kubernetes/pkg/kubelet/pod_workers_test.go fakeQueue.
export class FakeQueue implements WorkQueue {
	readonly queue: FakeQueueItem[] = [];
	currentStart = 0;

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakeQueue.Empty.
	empty(): boolean {
		return this.queue.length - this.currentStart === 0;
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakeQueue.Items.
	items(): FakeQueueItem[] {
		return [...this.queue];
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakeQueue.Set.
	set(): Set<string> {
		const work = new Set<string>();
		for (const item of this.queue.slice(this.currentStart)) {
			work.add(item.uid);
		}
		return work;
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakeQueue.Enqueue.
	enqueue(uid: string, delay: number): void {
		this.queue.push({ uid, delay });
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakeQueue.GetWork.
	getWork(): string[] {
		const work = this.queue.slice(this.currentStart).map((item) => item.uid);
		this.currentStart = this.queue.length;
		return work;
	}
}

export interface syncPodRecord {
	name: string;
	updateType?: UpdatePodOptions["updateType"];
	gracePeriod?: number;
	runningPod?: Pod;
	terminated?: boolean;
}

// Models kubernetes/pkg/kubelet/pod_workers_test.go createPodWorkers.
export function createPodWorkers(): [
	podWorkers: PodWorkersImpl,
	fakeRuntime: FakeRuntime,
	processed: Map<string, syncPodRecord[]>,
	fakeClock: FakePassiveClock,
] {
	const clock = newFakePassiveClock(new Date(1_000));
	const fakeRuntime = new FakeRuntime();
	const fakeCache = newFakeCache(fakeRuntime);
	const processed = new Map<string, syncPodRecord[]>();
	const record = (uid: string, update: syncPodRecord) => {
		processed.set(uid, [...(processed.get(uid) ?? []), update]);
	};
	const podWorkers = new PodWorkersImpl(
		clock,
		new FakeQueue(),
		60 * 1000,
		1000,
		{
			async syncPod(_ctx, updateType, pod) {
				if (!pod) {
					throw new Error("syncPod requires a pod");
				}
				const uid = pod.metadata?.uid ?? "";
				record(uid, { name: pod.metadata?.name ?? "", updateType });
				return [false, undefined, undefined];
			},
			async syncTerminatingPod(_ctx, pod, _podStatus, gracePeriod) {
				const uid = pod.metadata?.uid ?? "";
				record(uid, {
					name: pod.metadata?.name ?? "",
					updateType: "kill",
					gracePeriod,
				});
				return undefined;
			},
			async syncTerminatingRuntimePod(_ctx, runningPod) {
				record(runningPod.id, {
					name: runningPod.name,
					updateType: "kill",
					runningPod,
				});
				return undefined;
			},
			async syncTerminatedPod(_ctx, pod) {
				const uid = pod.metadata?.uid ?? "";
				record(uid, { name: pod.metadata?.name ?? "", terminated: true });
				return undefined;
			},
		},
		fakeCache,
	);
	return [podWorkers, fakeRuntime, processed, clock];
}

// Models kubernetes/pkg/kubelet/pod_workers_test.go drainAllWorkers.
export async function drainAllWorkers(podWorkers: PodWorkersImpl): Promise<void> {
	for (;;) {
		let stillWorking = false;
		for (const status of podWorkers.podSyncStatuses.values()) {
			if (status.working) {
				stillWorking = true;
				break;
			}
		}
		if (!stillWorking) {
			return;
		}
		await wait(50);
	}
}

export interface TestKubelet {
	kubelet: Kubelet;
	fakeRuntime: FakeRuntime;
	fakePodWorkers: FakePodWorkers;
	fakeKubeClient: KubeClient;
	fakeClock: Clock;
	cleanup(): Promise<void>;
}

// TypeScript imports execute top-level test registration, unlike Go package test
// files. Keep these upstream kubelet_test.go helpers in a side-effect-free module
// so kubelet test files can share them without importing each other's suites.

// Models kubernetes/pkg/kubelet/kubelet_test.go newTestKubelet.
export function newTestKubelet(controllerAttachDetachEnabled: boolean): TestKubelet {
	const imageList: Image[] = [
		{
			id: "abc",
			repoTags: ["registry.k8s.io:v1", "registry.k8s.io:v2"],
			repoDigests: [],
			size: 123,
			spec: { image: "abc" },
			pinned: false,
		},
		{
			id: "efg",
			repoTags: ["registry.k8s.io:v3", "registry.k8s.io:v4"],
			repoDigests: [],
			size: 456,
			spec: { image: "efg" },
			pinned: false,
		},
	];
	return newTestKubeletWithImageList(
		imageList,
		controllerAttachDetachEnabled,
		true,
		true,
		false,
		false,
	);
}

// Models kubernetes/pkg/kubelet/kubelet_test.go newTestKubeletWithImageList.
export function newTestKubeletWithImageList(
	imageList: Image[],
	controllerAttachDetachEnabled: boolean,
	_initFakeVolumePlugin: boolean,
	_localStorageCapacityIsolation: boolean,
	_excludeAdmitHandlers: boolean,
	_enableResizing: boolean,
): TestKubelet {
	if (controllerAttachDetachEnabled) {
		throw new Error("controller attach/detach volume behavior is not implemented");
	}
	const tCtx = context.background();
	const fakeClock = new Clock();
	const etcd = new Etcd(fakeClock);
	const kubeConfig = new KubeConfig({
		clock: fakeClock,
		etcd,
		serviceCIDR: testServiceCIDR,
		nodePortRange: testNodePortRange,
	});
	const fakeKubeClient = new KubeClient(kubeConfig);
	const fakeRuntime = new FakeRuntime();
	fakeRuntime.imageList = imageList;
	fakeRuntime.runtimeStatus = new RuntimeStatus({
		conditions: [
			new RuntimeCondition({ type: runtimeReady, status: true }),
			new RuntimeCondition({ type: networkReady, status: true }),
		],
	});
	fakeRuntime.versionInfo = "1.5.0";
	fakeRuntime.runtimeType = "test";
	const commandRunner = new FakeContainerCommandRunner();
	const podStartupLatencyTracker = new NoopPodStartupSLIObserver();
	const recorder = new EventRecorderImpl({
		api: fakeKubeClient.corev1,
		clock: fakeClock,
		component: "kubelet",
		host: testKubeletHostname,
	});
	const node: V1Node = {
		metadata: {
			name: testKubeletHostname,
			uid: testKubeletHostname,
		},
		status: {
			addresses: [
				{ type: "InternalIP", address: "127.0.0.1" },
				{ type: "InternalIP", address: "::1" },
				{ type: "Hostname", address: testKubeletHostname },
			],
		},
	};
	const [kubeletCtx, cancelContext] = context.withCancel(tCtx);
	const podConfig = newPodConfig(recorder, podStartupLatencyTracker, fakeClock);
	const podManager = new PodManager();
	const livenessManager = new ResultsManager();
	const readinessManager = new ResultsManager();
	const startupManager = new ResultsManager();
	const runtimeState = newRuntimeState(30 * 1000, fakeClock);
	runtimeState.setNetworkState(undefined);
	const podCache = new PodStatusCache();
	const workQueue = new BasicWorkQueue(fakeClock);
	const kubelet = new Kubelet({
		ctx: kubeletCtx,
		cancelContext,
		hostname: testKubeletHostname,
		nodeName: testKubeletHostname,
		kubeClient: fakeKubeClient,
		resyncIntervalMs: 60 * 1000,
		dnsConfigurer: new Configurer({
			recorder,
			nodeRef: {
				kind: "Node",
				name: testKubeletHostname,
				uid: testKubeletHostname,
				namespace: "",
			},
			nodeIPs: ["127.0.0.1", "::1"],
			clusterDNS: ["10.96.0.10"],
			clusterDomain: "cluster.local",
			resolverConfig: "",
		}),
		serviceLister: {
			list: async (_selector) => [[], undefined],
		},
		serviceHasSynced: () => true,
		nodeLister: {
			get: async (name) => [name === testKubeletHostname ? node : undefined, undefined],
			list: async (selector) => [
				[node].filter((candidate) => selector.matches(new LabelSet(candidate.metadata?.labels))),
				undefined,
			],
		},
		nodeHasSynced: () => true,
		cachedNode: node,
		podConfig,
		sourcesReady: newSourcesReady(podConfig.seenAllSources.bind(podConfig)),
		runtimeService: undefined,
		imageService: undefined,
		containerRuntime: fakeRuntime,
		runtimeCache: newFakeRuntimeCache(fakeRuntime),
		runtimeState,
		runner: commandRunner,
		podManager,
		probeManager: new FakeManager(),
		livenessManager,
		readinessManager,
		startupManager,
		podCache,
		recorder,
		workQueue,
		crashLoopBackOff: newBackOff(10 * 1000, 300 * 1000, fakeClock),
		clock: fakeClock,
		nodeIPs: ["127.0.0.1", "::1"],
		nodeAddresses: node.status?.addresses,
	});
	kubelet.statusManager = new StatusManagerImpl({
		clock: fakeClock,
		kubeClient: fakeKubeClient,
		podManager,
		podDeletionSafety: kubelet,
		podStartupLatencyHelper: podStartupLatencyTracker,
	});
	const fakePodWorkers = new FakePodWorkers(
		podCache,
		(ctx, updateType, pod, mirrorPod, podStatus) =>
			kubelet.syncPod(ctx, updateType, pod, mirrorPod, podStatus),
	);
	kubelet.podWorkers = fakePodWorkers;
	kubelet.pleg = new GenericPLEG(
		fakeRuntime,
		new Channel<PodLifecycleEvent>(100),
		{
			relistPeriodMs: 1000,
			relistThresholdMs: 3 * 60 * 1000,
		},
		podCache,
		fakeClock,
		kubeletCtx,
	);
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

	// The simulator does not model the upstream test kubelet's host filesystem,
	// volume/CSI/DRA, cadvisor/stats, allocation/resizing, eviction/shutdown,
	// certificate, or static-pod manager dependencies.
	return {
		kubelet,
		fakeRuntime,
		fakePodWorkers,
		fakeKubeClient,
		fakeClock,
		async cleanup() {
			await kubelet.close();
		},
	};
}
