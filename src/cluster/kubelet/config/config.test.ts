/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import type { V1Pod } from "../../../client";
import { FakeRecorder, newFakeRecorder } from "../../../client-go/tools/record/fake";
import { Clock } from "../../../clock";
import { select, type ReadOnlyChannel, type WriteOnlyChannel } from "../../../go/channel";
import * as context from "../../../go/context";
import { deepEqual } from "../../../deep-equal";
import { browser } from "../../../test/describe";
import { failedValidation } from "../events";
import type { PodUpdate } from "../types/pod-update";
import { newPodConfig, podsDifferSemantically, type PodConfig, type SourceUpdate } from "./config";

const testSource = "test";

type TestPod = V1Pod & {
	metadata: NonNullable<V1Pod["metadata"]>;
	spec: NonNullable<V1Pod["spec"]>;
};

browser.describe("PodConfig", () => {
	// Models kubernetes/pkg/kubelet/config/config_test.go TestNewPodAdded.
	it("sends add updates for new pods", async () => {
		const [channel, ch] = createPodConfigTester(context.background());
		await channel.send(createSourceUpdate(createValidPod("foo", "new")));

		await expectPodUpdate(ch, createPodUpdate("ADD", testSource, createValidPod("foo", "new")));
	});

	// Models kubernetes/pkg/kubelet/config/config_test.go TestNewPodAddedInvalidNamespace.
	it("sends add updates for new pods with invalid namespace", async () => {
		const [channel, ch] = createPodConfigTester(context.background());
		await channel.send(createSourceUpdate(createValidPod("foo", "")));

		await expectPodUpdate(ch, createPodUpdate("ADD", testSource, createValidPod("foo", "")));
	});

	// Models kubernetes/pkg/kubelet/config/config_test.go TestNewPodAddedDefaultNamespace.
	it("sends add updates for new pods in the default namespace", async () => {
		const [channel, ch] = createPodConfigTester(context.background());
		await channel.send(createSourceUpdate(createValidPod("foo", "default")));

		await expectPodUpdate(ch, createPodUpdate("ADD", testSource, createValidPod("foo", "default")));
	});

	// Models kubernetes/pkg/kubelet/config/config_test.go TestNewPodAddedDifferentNamespaces.
	it("treats pods with the same name in different namespaces as distinct", async () => {
		const [channel, ch] = createPodConfigTester(context.background());
		const pod1 = createValidPod("foo", "default");
		await channel.send(createSourceUpdate(pod1));
		await expectPodUpdate(ch, createPodUpdate("ADD", testSource, createValidPod("foo", "default")));

		const pod2 = createValidPod("foo", "new");
		await channel.send(createSourceUpdate(pod1, pod2));
		await expectPodUpdate(ch, createPodUpdate("ADD", testSource, createValidPod("foo", "new")));
	});

	// Models kubernetes/pkg/kubelet/config/config_test.go TestInvalidPodFiltered.
	it("filters duplicate pod full names and records validation events", async () => {
		const [channel, ch] = createPodConfigTester(context.background());
		await channel.send(createSourceUpdate(createValidPod("foo", "new")));
		await expectPodUpdate(ch, createPodUpdate("ADD", testSource, createValidPod("foo", "new")));

		await channel.send(createSourceUpdate(createValidPod("foo", "new")));
		await expectNoPodUpdate(ch);
	});

	// Simulator-only test.
	it("records validation events for duplicate pod full names in a source update", async () => {
		const recorder = newFakeRecorder(20);
		const config = newPodConfig(recorder, new MockPodStartupSLIObserver(), new Clock());
		const channel = config.channel(context.background(), testSource);
		const ch = config.updates();
		await channel.send(
			createSourceUpdate(createValidPod("foo", "new"), createValidPod("foo", "new")),
		);

		await expectPodUpdate(ch, createPodUpdate("ADD", testSource, createValidPod("foo", "new")));
		expect(fetchEvent(recorder)).toContain(`Warning ${failedValidation}`);
	});

	// Models kubernetes/pkg/kubelet/config/config_test.go TestNewPodAddedUpdatedRemoved.
	it("converts source snapshots into add, update, and remove operations", async () => {
		const [channel, ch] = createPodConfigTester(context.background());
		await channel.send(createSourceUpdate(createValidPod("foo", "new")));
		await expectPodUpdate(ch, createPodUpdate("ADD", testSource, createValidPod("foo", "new")));

		await expectNoPodUpdate(ch);

		const pod = createValidPod("foo", "new");
		pod.spec = {
			...pod.spec,
			containers: [{ name: "bar", image: "test", imagePullPolicy: "IfNotPresent" }],
		};
		await channel.send(createSourceUpdate(pod));
		await expectPodUpdate(ch, createPodUpdate("UPDATE", testSource, pod));

		await channel.send(createSourceUpdate());
		await expectPodUpdate(ch, createPodUpdate("REMOVE", testSource, pod));
	});

	// Models kubernetes/pkg/kubelet/config/config_test.go TestNewPodAddedDelete.
	it("converts graceful deletion into delete operations", async () => {
		const [channel, ch] = createPodConfigTester(context.background());
		const addedPod = createValidPod("foo", "new");
		await channel.send(createSourceUpdate(addedPod));
		await expectPodUpdate(ch, createPodUpdate("ADD", testSource, addedPod));

		const deletedPod = createValidPod("foo", "new");
		deletedPod.metadata.deletionTimestamp = new Date();
		await channel.send(createSourceUpdate(deletedPod));

		await expectPodUpdate(ch, createPodUpdate("DELETE", testSource, addedPod));
	});

	// Models kubernetes/pkg/kubelet/config/config_test.go TestNewPodAddedUpdatedSet.
	it("orders remove, add, and update operations from a changed set", async () => {
		const [channel, ch] = createPodConfigTester(context.background());
		let podUpdate = createSourceUpdate(
			createValidPod("foo", "new"),
			createValidPod("foo2", "new"),
			createValidPod("foo3", "new"),
		);
		await channel.send(podUpdate);
		await expectPodUpdate(
			ch,
			createPodUpdate(
				"ADD",
				testSource,
				createValidPod("foo", "new"),
				createValidPod("foo2", "new"),
				createValidPod("foo3", "new"),
			),
		);

		await channel.send(podUpdate);
		await expectNoPodUpdate(ch);

		const pod = createValidPod("foo2", "new");
		pod.spec = {
			...pod.spec,
			containers: [{ name: "bar", image: "test", imagePullPolicy: "IfNotPresent" }],
		};
		podUpdate = createSourceUpdate(
			pod,
			createValidPod("foo3", "new"),
			createValidPod("foo4", "new"),
		);
		await channel.send(podUpdate);

		await expectPodUpdate(
			ch,
			createPodUpdate("REMOVE", testSource, createValidPod("foo", "new")),
			createPodUpdate("ADD", testSource, createValidPod("foo4", "new")),
			createPodUpdate("UPDATE", testSource, pod),
		);
	});

	// Models kubernetes/pkg/kubelet/config/config_test.go TestNewPodAddedSetReconciled.
	it("converts status-only source changes into reconcile operations", async () => {
		const [channel, ch] = createPodConfigTester(context.background());
		let podWithStatusChange: V1Pod;
		let pods = newTestPods(false, false);

		await channel.send(createSourceUpdate(...pods));
		await expectPodUpdate(ch, createPodUpdate("ADD", testSource, ...pods));

		await channel.send(createSourceUpdate(...pods));
		await expectNoPodUpdate(ch);

		pods = newTestPods(true, false);
		podWithStatusChange = pods[0];
		await channel.send(createSourceUpdate(...pods));
		await expectPodUpdate(ch, createPodUpdate("RECONCILE", testSource, podWithStatusChange));

		pods = newTestPods(true, true);
		podWithStatusChange = pods[0];
		await channel.send(createSourceUpdate(...pods));
		await expectPodUpdate(ch, createPodUpdate("UPDATE", testSource, podWithStatusChange));
	});

	// Models kubernetes/pkg/kubelet/config/config_test.go TestInitialEmptySet.
	it("sends an empty add update for the first empty source set", async () => {
		const [channel, ch] = createPodConfigTester(context.background());
		await channel.send(createSourceUpdate());
		await expectPodUpdate(ch, createPodUpdate("ADD", testSource));

		await channel.send(createSourceUpdate());
		await channel.send(createSourceUpdate(createValidPod("foo", "new")));
		await expectPodUpdate(ch, createPodUpdate("ADD", testSource, createValidPod("foo", "new")));
	});

	// Models kubernetes/pkg/kubelet/config/config_test.go TestPodUpdateAnnotations.
	it("updates pods when non-local annotations change", async () => {
		const [channel, ch] = createPodConfigTester(context.background());
		const pod = createValidPod("foo2", "new");
		pod.metadata.annotations = { "kubernetes.io/blah": "blah" };
		const clone = deepCopyPod(pod);

		await channel.send(
			createSourceUpdate(createValidPod("foo1", "new"), clone, createValidPod("foo3", "new")),
		);
		await expectPodUpdate(
			ch,
			createPodUpdate(
				"ADD",
				testSource,
				createValidPod("foo1", "new"),
				pod,
				createValidPod("foo3", "new"),
			),
		);

		pod.metadata.annotations["kubernetes.io/blah"] = "superblah";
		await channel.send(
			createSourceUpdate(createValidPod("foo1", "new"), pod, createValidPod("foo3", "new")),
		);
		await expectPodUpdate(ch, createPodUpdate("UPDATE", testSource, pod));

		pod.metadata.annotations["kubernetes.io/otherblah"] = "doh";
		await channel.send(
			createSourceUpdate(createValidPod("foo1", "new"), pod, createValidPod("foo3", "new")),
		);
		await expectPodUpdate(ch, createPodUpdate("UPDATE", testSource, pod));

		delete pod.metadata.annotations["kubernetes.io/blah"];
		await channel.send(
			createSourceUpdate(createValidPod("foo1", "new"), pod, createValidPod("foo3", "new")),
		);
		await expectPodUpdate(ch, createPodUpdate("UPDATE", testSource, pod));
	});

	// Models kubernetes/pkg/kubelet/config/config_test.go TestPodUpdateLabels.
	it("updates pods when labels change", async () => {
		const [channel, ch] = createPodConfigTester(context.background());
		const pod = createValidPod("foo2", "new");
		pod.metadata.labels = { key: "value" };
		const clone = deepCopyPod(pod);

		await channel.send(createSourceUpdate(clone));
		await expectPodUpdate(ch, createPodUpdate("ADD", testSource, pod));

		pod.metadata.labels["key"] = "newValue";
		await channel.send(createSourceUpdate(pod));
		await expectPodUpdate(ch, createPodUpdate("UPDATE", testSource, pod));
	});

	// Models kubernetes/pkg/kubelet/config/config_test.go TestPodConfigRace.
	it("handles concurrent channel and seen-source calls", async () => {
		const clock = new Clock();
		const config = newPodConfig(new FakeRecorder(), new MockPodStartupSLIObserver(), clock);
		const seenSources = new Set<string>([testSource]);
		const iterations = 100;

		await expect(
			Promise.all([
				(async () => {
					for (let i = 0; i < iterations; i++) {
						config.channel(context.background(), String(i));
					}
				})(),
				(async () => {
					for (let i = 0; i < iterations; i++) {
						config.seenAllSources(seenSources);
					}
				})(),
			]),
		).resolves.toBeDefined();
	});
});

function newTestPods(touchStatus: boolean, touchSpec: boolean): [TestPod, TestPod, TestPod] {
	const pods: [TestPod, TestPod, TestPod] = [
		createValidPod("changeable-pod-0", "new"),
		createValidPod("constant-pod-1", "new"),
		createValidPod("constant-pod-2", "new"),
	];
	if (touchStatus) {
		pods[0].status = { message: String(Math.random()) };
	}
	if (touchSpec) {
		const container = pods[0].spec.containers[0];
		if (!container) {
			throw new Error("missing container from test pod");
		}
		container.name = String(Math.random());
	}
	return pods;
}

function createPodConfigTester(
	ctx: context.Context,
): [WriteOnlyChannel<SourceUpdate>, ReadOnlyChannel<PodUpdate>, PodConfig] {
	const clock = new Clock();
	const config = newPodConfig(new FakeRecorder(), new MockPodStartupSLIObserver(), clock);
	const channel = config.channel(ctx, testSource);
	const ch = config.updates();
	return [channel.writeOnly(), ch, config];
}

function createValidPod(name: string, namespace: string): TestPod {
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			uid: name + namespace,
			name,
			namespace,
		},
		spec: {
			restartPolicy: "Always",
			dnsPolicy: "ClusterFirst",
			containers: [
				{
					name: "ctr",
					image: "image",
					imagePullPolicy: "IfNotPresent",
					terminationMessagePolicy: "File",
				},
			],
		},
	};
}

function createPodUpdate(op: PodUpdate["op"], source: string, ...pods: V1Pod[]): PodUpdate {
	return { pods, op, source };
}

function createSourceUpdate(...pods: V1Pod[]): SourceUpdate {
	return { pods };
}

async function expectPodUpdate(
	ch: ReadOnlyChannel<PodUpdate>,
	...expected: PodUpdate[]
): Promise<void> {
	for (const expectedUpdate of expected) {
		const result = await ch.receive();
		if (!result.ok) {
			throw new Error("update channel closed");
		}
		const update = result.value;
		sortPods(update.pods);
		sortPods(expectedUpdate.pods);

		expect({ ...update, pods: undefined }).toEqual({ ...expectedUpdate, pods: undefined });
		expect(update.pods.length).toBe(expectedUpdate.pods.length);
		for (let i = 0; i < expectedUpdate.pods.length; i++) {
			const actualPod = update.pods[i];
			const expectedPod = expectedUpdate.pods[i];
			if (!actualPod || !expectedPod) {
				throw new Error("missing pod from update");
			}
			expect(podsEquivalentForTest(actualPod, expectedPod)).toBe(true);
		}
	}
	await expectNoPodUpdate(ch);
}

async function expectNoPodUpdate(ch: ReadOnlyChannel<PodUpdate>): Promise<void> {
	const result = await select()
		.case(ch, (update) => update)
		.default(() => undefined);
	expect(result).toBeUndefined();
}

function sortPods(pods: V1Pod[]): void {
	pods.sort((left, right) =>
		(left.metadata?.namespace ?? "").localeCompare(right.metadata?.namespace ?? ""),
	);
}

function podsEquivalentForTest(actual: V1Pod, expected: V1Pod): boolean {
	return !podsDifferSemantically(expected, actual) && deepEqual(expected.status, actual.status);
}

function deepCopyPod(pod: V1Pod): V1Pod {
	return structuredClone(pod);
}

class MockPodStartupSLIObserver {
	observedPodOnWatch(_pod: V1Pod, _when: Date): void {}
	recordStatusUpdated(_pod: V1Pod): void {}
	deletePodStartupState(_podUid: string): void {}
}

function fetchEvent(recorder: FakeRecorder): string {
	const event = recorder.events?.tryReceive();
	if (!event?.ok) {
		return "";
	}
	return event.value;
}
