import type { V1Pod, V1PodSpec } from "../../client";
import { KubeConfig } from "../../client";
import { Clock } from "../../clock";
import * as context from "../../go/context";
import { Mutex } from "../../go/sync/mutex";
import { KubeClient } from "../cluster";
import { ClusterNetwork } from "../cni";
import { Etcd } from "../etcd";
import { EventRecorder } from "../events";
import {
	networkReady,
	RuntimeCondition,
	RuntimeStatus,
	runtimeReady,
	type Image,
	type PodStatus as PodRuntimeStatus,
	type ROCache,
} from "./container";
import { FakeContainerCommandRunner, FakeRuntime, newFakeRuntimeCache } from "./container/testing";
import type { KubeletConfiguration } from "./apis/config";
import { newPodConfig } from "./config";
import { newMainKubelet, NoopPodStartupSLIObserver, type Kubelet } from "./kubelet";
import type { PodWorkers, PodWorkerSync, SyncPodResult, UpdatePodOptions } from "./pod-workers";
import { FakeManager } from "./prober/testing/fake-manager";
import type { SyncPodType } from "./types/pod-update";
import type { WorkQueue } from "./util/queue/work-queue";

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

// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.
export class FakePodWorkers implements PodWorkers {
	private readonly lock = new Mutex();
	syncPodFn: SyncPodFnType;
	readonly triggeredDeletion: string[] = [];
	readonly triggeredTerminal: string[] = [];
	readonly running = new Map<string, boolean>();
	readonly terminating = new Map<string, boolean>();
	readonly terminated = new Map<string, boolean>();
	readonly terminationRequested = new Map<string, boolean>();
	readonly finished = new Map<string, boolean>();
	readonly removeRuntime = new Map<string, boolean>();
	readonly removeContent = new Map<string, boolean>();
	readonly terminatingStaticPods = new Map<string, boolean>();

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
	syncKnownPods(_desiredPods: V1Pod[]): Map<string, PodWorkerSync> {
		return new Map<string, PodWorkerSync>();
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.IsPodKnownTerminated.
	isPodKnownTerminated(uid: string): boolean {
		return this.terminated.get(uid) ?? false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.CouldHaveRunningContainers.
	couldHaveRunningContainers(uid: string): boolean {
		return this.running.get(uid) ?? false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.ShouldPodBeFinished.
	shouldPodBeFinished(uid: string): boolean {
		return this.finished.get(uid) ?? false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.IsPodTerminationRequested.
	isPodTerminationRequested(uid: string): boolean {
		return this.terminationRequested.get(uid) ?? false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.ShouldPodContainersBeTerminating.
	shouldPodContainersBeTerminating(uid: string): boolean {
		return this.terminating.get(uid) ?? false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.ShouldPodRuntimeBeRemoved.
	shouldPodRuntimeBeRemoved(uid: string): boolean {
		return this.removeRuntime.get(uid) ?? false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.setPodRuntimeBeRemoved.
	setPodRuntimeBeRemoved(uid: string): void {
		this.removeRuntime.clear();
		this.removeRuntime.set(uid, true);
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.ShouldPodContentBeRemoved.
	shouldPodContentBeRemoved(uid: string): boolean {
		return this.removeContent.get(uid) ?? false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go fakePodWorkers.IsPodForMirrorPodTerminatingByFullName.
	isPodForMirrorPodTerminatingByFullName(podFullname: string): boolean {
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
	const network = new ClusterNetwork();
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
	const recorder = new EventRecorder({
		api: fakeKubeClient.corev1,
		clock: fakeClock,
		component: "kubelet",
		host: testKubeletHostname,
	});
	const kubeletConfiguration: KubeletConfiguration = {
		syncFrequencyMs: 60 * 1000,
		clusterDNS: ["10.96.0.10"],
		serializeImagePulls: true,
		maxParallelImagePulls: undefined,
		clusterDomain: "cluster.local",
	};
	const kubelet = newMainKubelet(
		tCtx,
		kubeletConfiguration,
		{
			kubeClient: fakeKubeClient,
			podListWatchClient: undefined,
			recorder,
			podStartupLatencyTracker,
			containerRuntime: fakeRuntime,
			runtimeCache: newFakeRuntimeCache(fakeRuntime),
			commandRunner,
			network,
			clock: fakeClock,
			podConfig: newPodConfig(recorder, podStartupLatencyTracker, fakeClock),
		},
		testKubeletHostname,
		testKubeletHostname,
	);
	kubelet.probeManager = new FakeManager();
	const fakePodWorkers = new FakePodWorkers(kubelet.podCache, kubelet.syncPod.bind(kubelet));
	kubelet.podWorkers = fakePodWorkers;
	kubelet.runtimeState.setNetworkState(undefined);

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
