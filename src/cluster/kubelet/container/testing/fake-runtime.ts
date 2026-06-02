import type { V1Container, V1Pod, V1PodStatus } from "../../../../client";
import type { Backoff } from "../../../../client-go/util/flowcontrol/backoff";
import { deepEqual } from "../../../../deep-equal";
import { deepMerge } from "../../../../deep-merge";
import { Channel, select } from "../../../../go/channel";
import type * as context from "../../../../go/context";
import type { DeepPartial } from "../../../../utility-types";
import type { ImageFsInfoResponse, PodSandboxConfig } from "../../../cri";
import type {
	CheckpointContainerRequest,
	ContainerEventResponse,
	MetricDescriptor,
	PodSandboxMetrics,
} from "../../../cri/runtime/v1/api";
import {
	ContainerID,
	errPodNotFound,
	newPod,
	PodSyncResult,
	type GCPolicy,
	type Image,
	type ImageSpec,
	type ImageStats,
	type Pod,
	type PodStatus,
	type Runtime,
	type RuntimeCache,
	type RuntimeStatus,
	type Status,
	type SwapBehavior,
	type Version,
} from "../index";

// Models kubernetes/pkg/kubelet/container/testing/fake_runtime.go FakePod.
export interface FakePod {
	pod: Pod;
	netnsPath: string;
}

// Models kubernetes/pkg/kubelet/container/testing/fake_runtime.go FakePod.
export function newFakePod(fakePod: DeepPartial<FakePod> = {}): FakePod {
	const normalizedFakePod: DeepPartial<FakePod> = { ...fakePod };
	if (fakePod.pod) {
		normalizedFakePod.pod = newPod(fakePod.pod);
	}
	return deepMerge<FakePod>(
		{
			pod: newPod(),
			netnsPath: "",
		},
		normalizedFakePod,
	);
}

// Models kubernetes/pkg/kubelet/container/testing/fake_runtime.go FakeRuntime.
export class FakeRuntime implements Runtime {
	calledFunctions: string[] = [];
	podList: FakePod[] = [];
	allPodList: FakePod[] = [];
	imageList: Image[] = [];
	imageFsStats: ImageFsInfoResponse["imageFilesystems"] = [];
	containerFsStats: ImageFsInfoResponse["containerFilesystems"] = [];
	apiPodStatus: V1PodStatus = {};
	podStatus: PodStatus = {
		id: "",
		name: "",
		namespace: "",
		ips: [],
		containerStatuses: [],
		sandboxStatuses: [],
		timestamp: new Date(0),
	};
	startedPods: string[] = [];
	killedPods: string[] = [];
	startedContainers: string[] = [];
	killedContainers: string[] = [];
	runtimeStatus: RuntimeStatus | undefined;
	versionInfo = "";
	apiVersionInfo = "";
	runtimeType = "";
	podResizeInProgress = false;
	syncResults: PodSyncResult | undefined;
	err: Error | undefined;
	inspectErr: Error | undefined;
	statusErr: Error | undefined;
	blockImagePulls = false;
	private imagePullTokenBucket: Channel<boolean> | undefined;
	private imagePullErrBucket: Channel<Error> | undefined;
	swapBehavior: Record<string, SwapBehavior> | undefined;

	updatePodCIDR(_ctx: context.Context, _podCIDR: string): Promise<Error | undefined> {
		return Promise.resolve(undefined);
	}

	private assertList(expect: string[], test: string[]): boolean {
		if (!deepEqual(expect, test)) {
			throw new Error(
				`AssertList: expected ${JSON.stringify(expect)}, got ${JSON.stringify(test)}`,
			);
		}
		return true;
	}

	assertCalls(calls: string[]): boolean {
		return this.assertList(calls, this.calledFunctions);
	}

	assertCallCounts(funcName: string, expectedCount: number): boolean {
		const actualCount = this.calledFunctions.filter((call) => call === funcName).length;
		if (expectedCount !== actualCount) {
			throw new Error(
				`AssertCallCounts: expected ${funcName} to be called ${expectedCount} times, ` +
					`but was actually called ${actualCount} times.`,
			);
		}
		return true;
	}

	assertStartedPods(pods: string[]): boolean {
		return this.assertList(pods, this.startedPods);
	}

	assertKilledPods(pods: string[]): boolean {
		return this.assertList(pods, this.killedPods);
	}

	assertStartedContainers(containers: string[]): boolean {
		return this.assertList(containers, this.startedContainers);
	}

	assertKilledContainers(containers: string[]): boolean {
		return this.assertList(containers, this.killedContainers);
	}

	type(): string {
		return this.runtimeType;
	}

	async version(_ctx: context.Context): Promise<[Version, Error | undefined]> {
		this.calledFunctions.push("Version");
		return [new FakeVersion(this.versionInfo), this.err];
	}

	async apiVersion(): Promise<[Version, Error | undefined]> {
		this.calledFunctions.push("APIVersion");
		return [new FakeVersion(this.apiVersionInfo), this.err];
	}

	async status(_ctx: context.Context): Promise<[RuntimeStatus | undefined, Error | undefined]> {
		this.calledFunctions.push("Status");
		return [this.runtimeStatus, this.statusErr];
	}

	async getPods(_ctx: context.Context, all: boolean): Promise<[Pod[], Error | undefined]> {
		this.calledFunctions.push("GetPods");
		const pods: Pod[] = [];
		if (all) {
			for (const fakePod of this.allPodList) {
				pods.push(fakePod.pod);
			}
		} else {
			for (const fakePod of this.podList) {
				pods.push(fakePod.pod);
			}
		}
		return [pods, this.err];
	}

	async getPod(
		_ctx: context.Context,
		podUid: string,
	): Promise<[Pod | undefined, Error | undefined]> {
		if (this.err) {
			return [undefined, this.err];
		}
		for (const fakePod of this.podList) {
			if (fakePod.pod.id === podUid) {
				return [fakePod.pod, undefined];
			}
		}
		for (const fakePod of this.allPodList) {
			if (fakePod.pod.id === podUid) {
				return [fakePod.pod, undefined];
			}
		}
		return [undefined, errPodNotFound];
	}

	async syncPod(
		_ctx: context.Context,
		pod: V1Pod,
		_podStatus: PodStatus,
		_pullSecrets: unknown[],
		_backOff: Backoff,
		_restartAllContainers: boolean,
	): Promise<PodSyncResult> {
		this.calledFunctions.push("SyncPod");
		this.startedPods.push(pod.metadata?.uid ?? "");
		for (const c of pod.spec?.containers ?? []) {
			this.startedContainers.push(c.name);
		}
		if (this.syncResults) {
			return this.syncResults;
		}
		const result = new PodSyncResult();
		if (this.err) {
			result.fail(this.err);
		}
		return result;
	}

	async killPod(
		_ctx: context.Context,
		_pod: V1Pod | undefined,
		runningPod: Pod,
		_gracePeriodOverride: number | undefined,
	): Promise<Error | undefined> {
		this.calledFunctions.push("KillPod");
		this.killedPods.push(runningPod.id);
		for (const c of runningPod.containers) {
			this.killedContainers.push(c.name);
		}
		return this.err;
	}

	runContainerInPod(
		container: V1Container,
		pod: V1Pod,
		_volumeMap: Map<string, unknown>,
	): Error | undefined {
		this.calledFunctions.push("RunContainerInPod");
		this.startedContainers.push(container.name);
		pod.spec ??= { containers: [] };
		pod.spec.containers ??= [];
		pod.spec.containers.push(container);
		for (const c of pod.spec.containers) {
			if (c.name === container.name) {
				return this.err;
			}
		}
		pod.spec.containers.push(container);
		return this.err;
	}

	killContainerInPod(container: V1Container, _pod: V1Pod): Error | undefined {
		this.calledFunctions.push("KillContainerInPod");
		this.killedContainers.push(container.name);
		return this.err;
	}

	generatePodStatus(_event: ContainerEventResponse): PodStatus {
		this.calledFunctions.push("GeneratePodStatus");
		return { ...this.podStatus };
	}

	async getPodStatus(
		_ctx: context.Context,
		_pod: Pod,
	): Promise<[PodStatus | undefined, Error | undefined]> {
		this.calledFunctions.push("GetPodStatus");
		return [{ ...this.podStatus }, this.err];
	}

	getContainerLogs(
		_ctx: context.Context,
		_pod: V1Pod,
		_containerID: ContainerID,
		_logOptions: unknown,
		_stdout: unknown,
		_stderr: unknown,
	): Error | undefined {
		this.calledFunctions.push("GetContainerLogs");
		return this.err;
	}

	async pullImage(
		ctx: context.Context,
		image: ImageSpec,
		credentials: unknown[],
		_podSandboxConfig: PodSandboxConfig,
	): Promise<[string, unknown | undefined, Error | undefined]> {
		this.calledFunctions.push("PullImage");
		this.imagePullTokenBucket ??= new Channel<boolean>(1);
		this.imagePullErrBucket ??= new Channel<Error>(1);
		const blockImagePulls = this.blockImagePulls;

		if (blockImagePulls) {
			const pullImageErr = await select()
				.case(ctx.done(), () => undefined)
				.case(this.imagePullTokenBucket.readOnly(), () => undefined)
				.case(this.imagePullErrBucket.readOnly(), (result) =>
					result.ok ? result.value : undefined,
				);
			if (pullImageErr) {
				return ["", undefined, pullImageErr];
			}
		}

		if (!this.err) {
			this.imageList.push({
				id: image.image,
				repoTags: [],
				repoDigests: [],
				size: 0,
				spec: image,
				pinned: false,
			});
		}

		const retCreds = credentials.length > 0 ? credentials[0] : undefined;
		return [image.image, retCreds, this.err];
	}

	unblockImagePulls(count: number): void {
		if (!this.imagePullTokenBucket) {
			return;
		}
		for (let i = 0; i < count; i++) {
			this.imagePullTokenBucket.trySend(true);
		}
	}

	sendImagePullError(err: Error): void {
		this.imagePullErrBucket?.trySend(err);
	}

	async getImageRef(_ctx: context.Context, image: ImageSpec): Promise<[string, Error | undefined]> {
		this.calledFunctions.push("GetImageRef");
		for (const i of this.imageList) {
			if (i.id === image.image) {
				return [i.id, undefined];
			}
		}
		return ["", this.inspectErr];
	}

	async getImageSize(
		_ctx: context.Context,
		_image: ImageSpec,
	): Promise<[number, Error | undefined]> {
		this.calledFunctions.push("GetImageSize");
		return [0, this.err];
	}

	async listImages(_ctx: context.Context): Promise<[Image[], Error | undefined]> {
		this.calledFunctions.push("ListImages");
		return [this.snapshot(this.imageList), this.err];
	}

	// Models kubernetes/pkg/kubelet/container/testing/fake_runtime.go snapshot.
	private snapshot(imageList: Image[]): Image[] {
		return [...imageList];
	}

	async removeImage(_ctx: context.Context, image: ImageSpec): Promise<Error | undefined> {
		this.calledFunctions.push("RemoveImage");
		let index = 0;
		for (let i = 0; i < this.imageList.length; i++) {
			if (this.imageList[i]?.id === image.image) {
				index = i;
				break;
			}
		}
		this.imageList.splice(index, 1);
		return this.err;
	}

	async garbageCollect(
		_ctx: context.Context,
		_gcPolicy: GCPolicy,
		_allSourcesReady: boolean,
		_evictNonDeletedPods: boolean,
	): Promise<Error | undefined> {
		this.calledFunctions.push("GarbageCollect");
		return this.err;
	}

	async deleteContainer(
		_ctx: context.Context,
		_containerID: ContainerID,
	): Promise<Error | undefined> {
		this.calledFunctions.push("DeleteContainer");
		return this.err;
	}

	async checkpointContainer(
		_ctx: context.Context,
		_options: CheckpointContainerRequest,
	): Promise<Error | undefined> {
		this.calledFunctions.push("CheckpointContainer");
		return this.err;
	}

	async listMetricDescriptors(
		_ctx: context.Context,
	): Promise<[MetricDescriptor[], Error | undefined]> {
		this.calledFunctions.push("ListMetricDescriptors");
		return [[], this.err];
	}

	async listPodSandboxMetrics(
		_ctx: context.Context,
	): Promise<[PodSandboxMetrics[], Error | undefined]> {
		this.calledFunctions.push("ListPodSandboxMetrics");
		return [[], this.err];
	}

	setContainerFsStats(val: ImageFsInfoResponse["containerFilesystems"]): void {
		this.containerFsStats = val;
	}

	setImageFsStats(val: ImageFsInfoResponse["imageFilesystems"]): void {
		this.imageFsStats = val;
	}

	async imageStats(_ctx: context.Context): Promise<[ImageStats | undefined, Error | undefined]> {
		this.calledFunctions.push("ImageStats");
		return [undefined, this.err];
	}

	async imageFsInfo(_ctx: context.Context): Promise<[ImageFsInfoResponse, Error | undefined]> {
		this.calledFunctions.push("ImageFsInfo");
		return [
			{
				imageFilesystems: this.imageFsStats,
				containerFilesystems: this.containerFsStats,
			},
			this.err,
		];
	}

	async getContainerStatus(
		_ctx: context.Context,
		_podUid: string,
		_id: ContainerID,
	): Promise<[Status | undefined, Error | undefined]> {
		this.calledFunctions.push("GetContainerStatus");
		return [
			{
				id: new ContainerID("", ""),
				name: "",
				state: "Unknown",
				createdAt: 0,
				image: "",
				imageID: "",
				imageRef: "",
				imageRuntimeHandler: "",
				hash: 0,
				restartCount: 0,
			},
			this.err,
		];
	}

	getContainerSwapBehavior(_pod: V1Pod, container: V1Container): SwapBehavior {
		if (this.swapBehavior && this.swapBehavior[container.name] !== undefined) {
			return this.swapBehavior[container.name] as SwapBehavior;
		}
		return "NoSwap";
	}

	isPodResizeInProgress(_allocatedPod: V1Pod, _podStatus: PodStatus): boolean {
		return this.podResizeInProgress;
	}

	async updateActuatedPodLevelResources(_actuatedPod: V1Pod): Promise<Error | undefined> {
		return undefined;
	}
}

// Models kubernetes/pkg/kubelet/container/testing/fake_runtime.go FakeHost.
export const fakeHost = "localhost:12345";

// Models kubernetes/pkg/kubelet/container/testing/fake_runtime.go FakeStreamingRuntime.
export class FakeStreamingRuntime extends FakeRuntime {
	async getExec(
		_ctx: context.Context,
		_id: ContainerID,
		_cmd: string[],
		_stdin: boolean,
		_stdout: boolean,
		_stderr: boolean,
		_tty: boolean,
	): Promise<[URL, Error | undefined]> {
		this.calledFunctions.push("GetExec");
		return [new URL(`http://${fakeHost}`), this.err];
	}

	async getAttach(
		_ctx: context.Context,
		_id: ContainerID,
		_stdin: boolean,
		_stdout: boolean,
		_stderr: boolean,
		_tty: boolean,
	): Promise<[URL, Error | undefined]> {
		this.calledFunctions.push("GetAttach");
		return [new URL(`http://${fakeHost}`), this.err];
	}

	async getPortForward(
		_ctx: context.Context,
		_podName: string,
		_podNamespace: string,
		_podUID: string,
		_ports: number[],
	): Promise<[URL, Error | undefined]> {
		this.calledFunctions.push("GetPortForward");
		return [new URL(`http://${fakeHost}`), this.err];
	}
}

// Models kubernetes/pkg/kubelet/container/testing/fake_runtime.go FakeVersion.
export class FakeVersion implements Version {
	constructor(readonly version: string) {}

	toString(): string {
		return this.version;
	}

	compare(other: string): [number, Error | undefined] {
		let result = 0;
		if (this.version > other) {
			result = 1;
		} else if (this.version < other) {
			result = -1;
		}
		return [result, undefined];
	}
}

// Models kubernetes/pkg/kubelet/container/testing/fake_runtime.go podsGetter.
type PodsGetter = Pick<Runtime, "getPods">;

// Models kubernetes/pkg/kubelet/container/testing/fake_runtime.go FakeRuntimeCache.
export class FakeRuntimeCache implements RuntimeCache {
	constructor(private readonly getter: PodsGetter) {}

	async getPods(ctx: context.Context): Promise<[Pod[], Error | undefined]> {
		return await this.getter.getPods(ctx, false);
	}

	async forceUpdateIfOlder(
		_ctx: context.Context,
		_minExpectedCacheTime: Date,
	): Promise<Error | undefined> {
		return undefined;
	}
}

// Models kubernetes/pkg/kubelet/container/testing/fake_runtime.go NewFakeRuntimeCache.
export function newFakeRuntimeCache(getter: PodsGetter): RuntimeCache {
	return new FakeRuntimeCache(getter);
}

// Models kubernetes/pkg/kubelet/container/testing/fake_runtime.go FakeContainerCommandRunner.
export class FakeContainerCommandRunner {
	stdout = "";
	err: Error | undefined;
	containerID: ContainerID | undefined;
	cmd: string[] = [];

	async runInContainer(
		_ctx: context.Context,
		containerID: ContainerID,
		cmd: string[],
		_timeoutSeconds?: number,
	): Promise<[string, Error | undefined]> {
		this.containerID = containerID;
		this.cmd = cmd;
		return [this.stdout, this.err];
	}
}
