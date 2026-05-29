import { KubeConfig } from "../../client";
import { Clock } from "../../clock";
import * as context from "../../go/context";
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
} from "./container";
import { FakeContainerCommandRunner, FakeRuntime, newFakeRuntimeCache } from "./container/testing";
import type { KubeletConfiguration } from "./apis/config";
import { newPodConfig } from "./config";
import { newMainKubelet, NoopPodStartupSLIObserver, type Kubelet } from "./kubelet";

const testServiceCIDR = "10.96.0.0/12";
const testNodePortRange = { from: 30000, to: 32767 };
const testKubeletHostname = "127.0.0.1";

export interface TestKubelet {
	kubelet: Kubelet;
	fakeRuntime: FakeRuntime;
	fakeKubeClient: KubeClient;
	fakeClock: Clock;
	cleanup(): Promise<void>;
}

// TypeScript imports execute top-level test registration, unlike Go package test
// files. Keep these upstream kubelet_test.go helpers in a side-effect-free module
// so kubelet test files can share them without importing each other's suites.

// Models kubernetes/pkg/kubelet/kubelet_test.go newTestKubelet.
export function newTestKubelet(): TestKubelet {
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
	return newTestKubeletWithImageList(imageList, false, true, true, false, false);
}

// Models kubernetes/pkg/kubelet/kubelet_test.go newTestKubeletWithImageList.
export function newTestKubeletWithImageList(
	imageList: Image[],
	_controllerAttachDetachEnabled: boolean,
	_initFakeVolumePlugin: boolean,
	_localStorageCapacityIsolation: boolean,
	_excludeAdmitHandlers: boolean,
	_enableResizing: boolean,
): TestKubelet {
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

	// The simulator does not model the upstream test kubelet's host filesystem,
	// volume/CSI/DRA, cadvisor/stats, allocation/resizing, eviction/shutdown,
	// certificate, or static-pod manager dependencies.
	return {
		kubelet,
		fakeRuntime,
		fakeKubeClient,
		fakeClock,
		async cleanup() {
			await kubelet.close();
		},
	};
}
