// oxlint-disable jest/expect-expect
import { expect, it } from "vitest";
import { Channel, select, type ReadOnlyChannel } from "../../../go/channel";
import type * as context from "../../../go/context";
import { browser } from "../../../test/describe";
import { Cluster } from "../../cluster";
import type { ContainerStatus, PodRuntimeStatus } from "../../cri";
import {
	buildContainerID,
	PodStatusCache,
	type Container as RuntimeContainer,
	type ContainerID,
	type Pod as RuntimePod,
	type Runtime,
	type State as ContainerState,
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
		pleg.relist();
		let expected: PodLifecycleEvent[] = [
			{ id: "1234", type: ContainerStarted, data: "c2" },
			{ id: "4567", type: ContainerDied, data: "c1" },
			{ id: "1234", type: ContainerDied, data: "c1" },
		];
		let actual = await getEventsFromChannel(ch);
		verifyEvents(expected, actual);

		pleg.relist();
		actual = await getEventsFromChannel(ch);
		expect(actual).toEqual([]);

		runtime.allPodList = [
			createTestPod("1234", [
				createTestContainer("c2", "Exited"),
				createTestContainer("c3", "Running"),
			]),
			createTestPod("4567", [createTestContainer("c4", "Running")]),
		];
		pleg.relist();
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
		pleg.relist();
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
		pleg.relist();
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
			pleg.relist();
			await getEventsFromChannel(ch);
		}

		runtime.allPodList = [createTestPod("1234", [createTestContainer("c1", "Running")])];
		pleg.relist();
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
			pleg.relist();
			await getEventsFromChannel(ch);
		}

		runtime.allPodList = [];
		pleg.relist();
		const expected: PodLifecycleEvent[] = [
			{ id: "1234", type: ContainerDied, data: "c2" },
			{ id: "1234", type: ContainerRemoved, data: "c2" },
		];
		const actual = await getEventsFromChannel(ch);
		verifyEvents(expected, actual);
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

	getPods(_all: boolean): RuntimePod[] {
		return this.allPodList;
	}

	getPod(
		_ctx: context.Context,
		podUid: string,
	): [pod: RuntimePod | undefined, err: Error | undefined] {
		return [this.allPodList.find((pod) => pod.id === podUid), undefined];
	}

	getPodStatus(
		_ctx: context.Context,
		pod: RuntimePod,
	): [podStatus: PodRuntimeStatus | undefined, err: Error | undefined] {
		return [
			{
				id: pod.id,
				name: pod.name,
				namespace: pod.namespace,
				ips: [],
				containerStatuses: pod.containers.map(containerStatus),
				sandboxStatuses: [],
			},
			undefined,
		];
	}

	async killPod(): Promise<void> {}

	async deleteContainer(_containerID: ContainerID): Promise<void> {}

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
		id,
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
		id: buildContainerID("fooRuntime", container.id),
		name: container.name,
		imageRef: container.imageRef,
		imageRuntimeHandler: container.imageRuntimeHandler,
		hash: container.hash,
		state: container.state,
		restartCount: 0,
		createdAt: container.createdAt,
		ready: container.state === "Running",
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
