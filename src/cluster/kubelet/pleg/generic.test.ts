// oxlint-disable jest/expect-expect
import { expect, it } from "vitest";
import { Channel, select, type ReadOnlyChannel } from "../../../go/channel";
import type * as context from "../../../go/context";
import type { Backoff } from "../../../client-go/util/flowcontrol/backoff";
import type { V1Pod } from "../../../client";
import { browser } from "../../../test/describe";
import { Cluster } from "../../cluster";
import type { MetricDescriptor, PodSandboxMetrics } from "../../cri/runtime/v1/api";
import {
	buildContainerID,
	PodSyncResult,
	PodStatusCache,
	RuntimeStatus,
	type Container as RuntimeContainer,
	type ContainerID,
	type GCPolicy,
	type Image,
	type ImageSpec,
	type ImageStats,
	type Pod as RuntimePod,
	type PodStatus as PodRuntimeStatus,
	type Runtime,
	type Status,
	type Status as ContainerStatus,
	type SwapBehavior,
	type State as ContainerState,
	type Version,
} from "../container";
import { ContainerDied, ContainerRemoved, ContainerStarted, type PodLifecycleEvent } from "./pleg";
import { GenericPLEG } from "./generic";

browser.describe("GenericPLEG", () => {
	// Mirrors kubernetes/pkg/kubelet/pleg/generic_test.go TestRelisting.
	it("relisting", async () => {
		const testPleg = newTestGenericPLEG();
		const { pleg, runtime } = testPleg;
		const ch = pleg.watch();

		runtime.allPodList = [
			createTestPod("1234", [
				createTestContainer("c1", "Exited"),
				createTestContainer("c2", "Running"),
				createTestContainer("c3", "Unknown"),
			]),
			createTestPod("4567", [createTestContainer("c1", "Exited")]),
		];
		await pleg.relist();
		let expected: PodLifecycleEvent[] = [
			{ id: "1234", type: ContainerStarted, data: "c2" },
			{ id: "4567", type: ContainerDied, data: "c1" },
			{ id: "1234", type: ContainerDied, data: "c1" },
		];
		let actual = await getEventsFromChannel(ch);
		verifyEvents(expected, actual);

		await pleg.relist();
		actual = await getEventsFromChannel(ch);
		expect(actual).toEqual([]);

		runtime.allPodList = [
			createTestPod("1234", [
				createTestContainer("c2", "Exited"),
				createTestContainer("c3", "Running"),
			]),
			createTestPod("4567", [createTestContainer("c4", "Running")]),
		];
		await pleg.relist();
		expected = [
			{ id: "1234", type: ContainerRemoved, data: "c1" },
			{ id: "1234", type: ContainerDied, data: "c2" },
			{ id: "1234", type: ContainerStarted, data: "c3" },
			{ id: "4567", type: ContainerRemoved, data: "c1" },
			{ id: "4567", type: ContainerStarted, data: "c4" },
		];
		actual = await getEventsFromChannel(ch);
		verifyEvents(expected, actual);
	});

	// Mirrors kubernetes/pkg/kubelet/pleg/generic_test.go TestEventChannelFull.
	it("event channel full", async () => {
		const testPleg = newTestGenericPLEGWithChannelSize(4);
		const { pleg, runtime } = testPleg;
		const ch = pleg.watch();

		runtime.allPodList = [
			createTestPod("1234", [
				createTestContainer("c1", "Exited"),
				createTestContainer("c2", "Running"),
				createTestContainer("c3", "Unknown"),
			]),
			createTestPod("4567", [createTestContainer("c1", "Exited")]),
		];
		await pleg.relist();
		const expected: PodLifecycleEvent[] = [
			{ id: "1234", type: ContainerStarted, data: "c2" },
			{ id: "4567", type: ContainerDied, data: "c1" },
			{ id: "1234", type: ContainerDied, data: "c1" },
		];
		let actual = await getEventsFromChannel(ch);
		verifyEvents(expected, actual);

		runtime.allPodList = [
			createTestPod("1234", [
				createTestContainer("c2", "Exited"),
				createTestContainer("c3", "Running"),
			]),
			createTestPod("4567", [createTestContainer("c4", "Running")]),
		];
		await pleg.relist();
		const allEvents: PodLifecycleEvent[] = [
			{ id: "1234", type: ContainerRemoved, data: "c1" },
			{ id: "1234", type: ContainerDied, data: "c2" },
			{ id: "1234", type: ContainerStarted, data: "c3" },
			{ id: "4567", type: ContainerRemoved, data: "c1" },
			{ id: "4567", type: ContainerStarted, data: "c4" },
		];
		actual = await getEventsFromChannel(ch);
		expect(actual).toHaveLength(4);
		expect(allEvents).toEqual(expect.arrayContaining(actual));
	});

	// Mirrors kubernetes/pkg/kubelet/pleg/generic_test.go testReportMissingContainers.
	it.each([1, 3])("reports missing containers after %i relist(s)", async (numRelists) => {
		const testPleg = newTestGenericPLEG();
		const { pleg, runtime } = testPleg;
		const ch = pleg.watch();
		runtime.allPodList = [
			createTestPod("1234", [
				createTestContainer("c1", "Running"),
				createTestContainer("c2", "Running"),
				createTestContainer("c3", "Exited"),
			]),
		];

		for (let i = 0; i < numRelists; i++) {
			await pleg.relist();
			await getEventsFromChannel(ch);
		}

		runtime.allPodList = [createTestPod("1234", [createTestContainer("c1", "Running")])];
		await pleg.relist();
		const expected: PodLifecycleEvent[] = [
			{ id: "1234", type: ContainerDied, data: "c2" },
			{ id: "1234", type: ContainerRemoved, data: "c2" },
			{ id: "1234", type: ContainerRemoved, data: "c3" },
		];
		const actual = await getEventsFromChannel(ch);
		verifyEvents(expected, actual);
	});

	// Mirrors kubernetes/pkg/kubelet/pleg/generic_test.go testReportMissingPods.
	it.each([1, 3])("reports missing pods after %i relist(s)", async (numRelists) => {
		const testPleg = newTestGenericPLEG();
		const { pleg, runtime } = testPleg;
		const ch = pleg.watch();
		runtime.allPodList = [createTestPod("1234", [createTestContainer("c2", "Running")])];

		for (let i = 0; i < numRelists; i++) {
			await pleg.relist();
			await getEventsFromChannel(ch);
		}

		runtime.allPodList = [];
		await pleg.relist();
		const expected: PodLifecycleEvent[] = [
			{ id: "1234", type: ContainerDied, data: "c2" },
			{ id: "1234", type: ContainerRemoved, data: "c2" },
		];
		const actual = await getEventsFromChannel(ch);
		verifyEvents(expected, actual);
	});

	it("serializes overlapping relists", async () => {
		const testPleg = newTestGenericPLEG();
		const { pleg, runtime } = testPleg;
		const enteredGetPods = new Channel<void>(2);
		const releaseGetPods = new Channel<void>(2);
		let activeGetPods = 0;
		let maxActiveGetPods = 0;
		runtime.getPodsHook = async () => {
			activeGetPods++;
			maxActiveGetPods = Math.max(maxActiveGetPods, activeGetPods);
			enteredGetPods.trySend();
			await releaseGetPods.receive();
			activeGetPods--;
		};

		const first = pleg.relist();
		await enteredGetPods.receive();
		const second = pleg.relist();
		await Promise.resolve();

		expect(maxActiveGetPods).toBe(1);

		releaseGetPods.trySend();
		await enteredGetPods.receive();
		releaseGetPods.trySend();
		await Promise.all([first, second]);
		expect(maxActiveGetPods).toBe(1);
	});
});

function newTestGenericPLEG(): {
	pleg: GenericPLEG;
	runtime: FakeRuntime;
} {
	return newTestGenericPLEGWithChannelSize(1000);
}

function newTestGenericPLEGWithChannelSize(channelSize: number): {
	pleg: GenericPLEG;
	runtime: FakeRuntime;
} {
	const cluster = new Cluster();
	const runtime = new FakeRuntime();
	const eventChannel = new Channel<PodLifecycleEvent>(channelSize);
	const pleg = new GenericPLEG(
		runtime,
		eventChannel,
		{ relistPeriodMs: 3_600_000, relistThresholdMs: 7_200_000 },
		new PodStatusCache(),
		cluster.clock,
		cluster.ctx,
	);
	return { pleg, runtime };
}

class FakeRuntime implements Runtime {
	allPodList: RuntimePod[] = [];
	getPodsHook?: () => Promise<void>;

	type(): string {
		return "fakeRuntime";
	}

	async version(): Promise<[version: Version | undefined, err: Error | undefined]> {
		return [undefined, undefined];
	}

	async apiVersion(): Promise<[version: Version | undefined, err: Error | undefined]> {
		return [undefined, undefined];
	}

	async status(): Promise<[status: RuntimeStatus | undefined, err: Error | undefined]> {
		return [new RuntimeStatus(), undefined];
	}

	async getPods(
		_ctx: context.Context,
		_all: boolean,
	): Promise<[pods: RuntimePod[], err: Error | undefined]> {
		await this.getPodsHook?.();
		return [this.allPodList, undefined];
	}

	async getPod(
		_ctx: context.Context,
		podUid: string,
	): Promise<[pod: RuntimePod | undefined, err: Error | undefined]> {
		return [this.allPodList.find((pod) => pod.id === podUid), undefined];
	}

	async getPodStatus(
		_ctx: context.Context,
		pod: RuntimePod,
	): Promise<[podStatus: PodRuntimeStatus | undefined, err: Error | undefined]> {
		return [
			{
				id: pod.id,
				name: pod.name,
				namespace: pod.namespace,
				ips: [],
				timestamp: pod.timestamp,
				containerStatuses: pod.containers.map(containerStatus),
				sandboxStatuses: [],
			},
			undefined,
		];
	}

	async garbageCollect(
		_ctx: context.Context,
		_gcPolicy: GCPolicy,
		_allSourcesReady: boolean,
		_evictNonDeletedPods: boolean,
	): Promise<Error | undefined> {
		return undefined;
	}

	async syncPod(
		_ctx: context.Context,
		_pod: V1Pod,
		_podStatus: PodRuntimeStatus,
		_pullSecrets: unknown[],
		_backOff: Backoff,
		_restartAllContainers: boolean,
	): Promise<PodSyncResult> {
		return new PodSyncResult();
	}

	async killPod(): Promise<Error | undefined> {
		return undefined;
	}

	async deleteContainer(
		_ctx: context.Context,
		_containerID: ContainerID,
	): Promise<Error | undefined> {
		return undefined;
	}

	async pullImage(
		_ctx: context.Context,
		image: ImageSpec,
	): Promise<[imageRef: string, credentialsUsed: unknown | undefined, err: Error | undefined]> {
		return [image.image, undefined, undefined];
	}

	async getImageRef(
		_ctx: context.Context,
		image: ImageSpec,
	): Promise<[imageRef: string, err: Error | undefined]> {
		return [image.image, undefined];
	}

	async listImages(): Promise<[images: Image[], err: Error | undefined]> {
		return [[], undefined];
	}

	async removeImage(): Promise<Error | undefined> {
		return undefined;
	}

	async imageStats(): Promise<[imageStats: ImageStats | undefined, err: Error | undefined]> {
		return [{ totalStorageBytes: 0 }, undefined];
	}

	async imageFsInfo(): Promise<[imageFsInfo: unknown, err: Error | undefined]> {
		return [undefined, undefined];
	}

	async getImageSize(): Promise<[imageSize: number, err: Error | undefined]> {
		return [0, undefined];
	}

	async updatePodCIDR(): Promise<Error | undefined> {
		return undefined;
	}

	async checkpointContainer(): Promise<Error | undefined> {
		return undefined;
	}

	generatePodStatus(): PodRuntimeStatus | undefined {
		return undefined;
	}

	async listMetricDescriptors(): Promise<
		[descriptors: MetricDescriptor[], err: Error | undefined]
	> {
		return [[], undefined];
	}

	async listPodSandboxMetrics(): Promise<[metrics: PodSandboxMetrics[], err: Error | undefined]> {
		return [[], undefined];
	}

	async getContainerStatus(
		_ctx: context.Context,
		_podUid: string,
		id: ContainerID,
	): Promise<[status: Status | undefined, err: Error | undefined]> {
		return [
			{
				id,
				name: id.id,
				image: "",
				imageID: "",
				imageRef: "",
				imageRuntimeHandler: "",
				hash: 0,
				state: "Running",
				restartCount: 0,
				createdAt: 0,
			},
			undefined,
		];
	}

	getContainerSwapBehavior(): SwapBehavior {
		return "NoSwap";
	}

	isPodResizeInProgress(): boolean {
		return false;
	}

	async updateActuatedPodLevelResources(): Promise<Error | undefined> {
		return undefined;
	}

	async runInContainer(): Promise<[output: string, err: Error | undefined]> {
		return ["", undefined];
	}
}

function createTestPod(id: string, containers: RuntimeContainer[]): RuntimePod {
	return {
		id,
		name: "pod",
		namespace: "default",
		createdAt: 0,
		timestamp: new Date(0),
		containers,
		sandboxes: [],
	};
}

function createTestContainer(id: string, state: ContainerState): RuntimeContainer {
	return {
		id: buildContainerID("fooRuntime", id),
		name: id,
		image: "busybox:1.36",
		imageID: "busybox:1.36",
		imageRef: "busybox:1.36",
		imageRuntimeHandler: "",
		hash: 0,
		state,
		podSandboxID: "sandbox-1",
		createdAt: 0,
	};
}

function containerStatus(container: RuntimeContainer): ContainerStatus {
	return {
		id: container.id,
		name: container.name,
		image: container.image,
		imageID: container.imageID,
		imageRef: container.imageRef,
		imageRuntimeHandler: container.imageRuntimeHandler,
		hash: container.hash,
		state: container.state,
		restartCount: 0,
		createdAt: container.createdAt,
	};
}

async function getEventsFromChannel(
	channel: ReadOnlyChannel<PodLifecycleEvent>,
): Promise<PodLifecycleEvent[]> {
	const events: PodLifecycleEvent[] = [];
	while (true) {
		const received = await select()
			.case(channel, (result) => result)
			.default(() => undefined);
		if (!received?.ok) {
			return events;
		}
		events.push(received.value);
	}
}

function verifyEvents(expected: PodLifecycleEvent[], actual: PodLifecycleEvent[]): void {
	expect(sortEvents(actual)).toEqual(sortEvents(expected));
}

function sortEvents(events: PodLifecycleEvent[]): PodLifecycleEvent[] {
	return [...events].sort((left, right) => {
		const idCompare = left.id.localeCompare(right.id);
		if (idCompare !== 0) {
			return idCompare;
		}
		const dataCompare = String(left.data ?? "").localeCompare(String(right.data ?? ""));
		if (dataCompare !== 0) {
			return dataCompare;
		}
		return left.type.localeCompare(right.type);
	});
}
