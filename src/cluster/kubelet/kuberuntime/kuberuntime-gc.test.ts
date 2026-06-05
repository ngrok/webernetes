import { expect, it } from "vitest";
import type { V1Container, V1Pod } from "../../../client";
import * as context from "../../../go/context";
import { browser } from "../../../test/describe";
import type { ContainerStatus as CRIContainerStatus } from "../../cri";
import type { PodSandbox } from "../../cri/runtime/v1/api";
import {
	createTestRuntimeManager,
	FakePodStateProvider,
	makeFakeContainers,
	makeFakePodSandboxes,
	makeTestContainer,
	makeTestPod,
	type ContainerTemplate,
	type SandboxTemplate,
} from "./kuberuntime-test-helpers";

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc_test.go TestSandboxGC.
browser.describe("sandboxGC", () => {
	it("evicts sandboxes using upstream table cases", async () => {
		const tCtx = context.background();
		const [fakeRuntime, , m, err] = createTestRuntimeManager(tCtx);
		expect(err).toBeUndefined();
		const podStateProvider = m.containerGC.podStateProvider as FakePodStateProvider;

		const makeGCSandbox = (
			pod: V1Pod,
			attempt: number,
			state: PodSandbox["state"],
			hasRunningContainers: boolean,
			isTerminating: boolean,
			createdAt: number,
		): SandboxTemplate => ({
			pod,
			state,
			attempt,
			createdAt,
			running: hasRunningContainers,
			terminating: isTerminating,
		});

		const pods = [
			makeTestPod("foo1", "new", "1234", [
				makeTestContainer("bar1", "busybox"),
				makeTestContainer("bar2", "busybox"),
			]),
			makeTestPod("foo2", "new", "5678", [makeTestContainer("bar3", "busybox")]),
			makeTestPod("deleted", "new", "9012", [makeTestContainer("bar4", "busybox")]),
		];

		const tests: SandboxGCTestCase[] = [
			{
				description:
					"notready sandboxes without containers for deleted pods should be garbage collected.",
				sandboxes: [makeGCSandbox(pods[2], 0, "NotReady", false, false, 0)],
				containers: [],
				remain: [],
				evictTerminatingPods: false,
			},
			{
				description:
					"ready sandboxes without containers for deleted pods should not be garbage collected.",
				sandboxes: [makeGCSandbox(pods[2], 0, "Ready", false, false, 0)],
				containers: [],
				remain: [0],
				evictTerminatingPods: false,
			},
			{
				description: "sandboxes for existing pods should not be garbage collected.",
				sandboxes: [
					makeGCSandbox(pods[0], 0, "Ready", true, false, 0),
					makeGCSandbox(pods[1], 0, "NotReady", true, false, 0),
				],
				containers: [],
				remain: [0, 1],
				evictTerminatingPods: false,
			},
			{
				description:
					"older exited sandboxes without containers for existing pods should be garbage collected if there are more than one exited sandboxes.",
				sandboxes: [
					makeGCSandbox(pods[0], 1, "NotReady", true, false, 1),
					makeGCSandbox(pods[0], 0, "NotReady", true, false, 0),
				],
				containers: [],
				remain: [0],
				evictTerminatingPods: false,
			},
			{
				description:
					"older exited sandboxes with containers for existing pods should not be garbage collected even if there are more than one exited sandboxes.",
				sandboxes: [
					makeGCSandbox(pods[0], 1, "NotReady", true, false, 1),
					makeGCSandbox(pods[0], 0, "NotReady", true, false, 0),
				],
				containers: [
					{
						pod: pods[0],
						container: pods[0].spec?.containers?.[0] as V1Container,
						sandboxAttempt: 0,
						createdAt: 0,
						state: "Exited",
					},
				],
				remain: [0, 1],
				evictTerminatingPods: false,
			},
			{
				description:
					"non-running sandboxes for existing pods should be garbage collected if evictTerminatingPods is set.",
				sandboxes: [
					makeGCSandbox(pods[0], 0, "Ready", true, true, 0),
					makeGCSandbox(pods[1], 0, "NotReady", true, true, 0),
				],
				containers: [],
				remain: [0],
				evictTerminatingPods: true,
			},
			{
				description: "sandbox with containers should not be garbage collected.",
				sandboxes: [makeGCSandbox(pods[0], 0, "NotReady", false, false, 0)],
				containers: [
					{
						pod: pods[0],
						container: pods[0].spec?.containers?.[0] as V1Container,
						createdAt: 0,
						state: "Exited",
					},
				],
				remain: [0],
				evictTerminatingPods: false,
			},
			{
				description: "multiple sandboxes should be handled properly.",
				sandboxes: [
					makeGCSandbox(pods[0], 1, "Ready", true, false, 1),
					makeGCSandbox(pods[0], 0, "NotReady", true, false, 0),
					makeGCSandbox(pods[1], 1, "NotReady", true, false, 1),
					makeGCSandbox(pods[1], 0, "NotReady", true, false, 0),
					makeGCSandbox(pods[2], 0, "NotReady", false, true, 0),
				],
				containers: [
					{
						pod: pods[1],
						container: pods[1].spec?.containers?.[0] as V1Container,
						sandboxAttempt: 1,
						createdAt: 0,
						state: "Exited",
					},
				],
				remain: [0, 2],
				evictTerminatingPods: false,
			},
		];

		for (const test of tests) {
			podStateProvider.removed = new Set<string>();
			podStateProvider.terminated = new Set<string>();
			const fakeSandboxes = await makeFakePodSandboxes(tCtx, m, test.sandboxes);
			const fakeContainers = await makeFakeContainers(tCtx, m, test.containers);
			for (const s of test.sandboxes) {
				if (!s.running && s.pod.metadata?.name === "deleted") {
					podStateProvider.removed.add(s.pod.metadata.uid ?? "");
				}
				if (s.terminating) {
					podStateProvider.terminated.add(s.pod.metadata?.uid ?? "");
				}
			}
			fakeRuntime.setFakeSandboxes(fakeSandboxes);
			fakeRuntime.setFakeContainers(fakeContainers);

			const gcErr = await m.containerGC.evictSandboxes(tCtx, test.evictTerminatingPods);
			expect(gcErr).toBeUndefined();
			const [realRemain, remainErr] = await fakeRuntime.listPodSandbox(tCtx);
			expect(remainErr).toBeUndefined();
			expect(realRemain).toHaveLength(test.remain.length);
			for (const remain of test.remain) {
				const [resp, statusErr] = await fakeRuntime.podSandboxStatus(
					tCtx,
					fakeSandboxes[remain]?.id ?? "",
				);
				expect(statusErr).toBeUndefined();
				expect(resp?.status?.id).toBe(fakeSandboxes[remain]?.id);
			}
		}
	});
});

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc_test.go TestContainerGC.
browser.describe("containerGC", () => {
	it("evicts containers using upstream table cases", async () => {
		const tCtx = context.background();
		const [fakeRuntime, , m, err, clock] = createTestRuntimeManager(tCtx);
		expect(err).toBeUndefined();
		const podStateProvider = m.containerGC.podStateProvider as FakePodStateProvider;
		const defaultGCPolicy = { minAgeMs: 60 * 60 * 1000, maxPerPodContainer: 2, maxContainers: 6 };

		const tests: ContainerGCTestCase[] = [
			{
				description: "all containers should be removed when max container limit is 0",
				containers: [makeGCContainer("foo", "bar", 0, 0, "Exited")],
				policy: { minAgeMs: 60 * 1000, maxPerPodContainer: 1, maxContainers: 0 },
				remain: [],
				evictTerminatingPods: false,
				allSourcesReady: true,
			},
			{
				description: "max containers should be complied when no max per pod container limit is set",
				containers: [
					makeGCContainer("foo", "bar", 4, 4, "Exited"),
					makeGCContainer("foo", "bar", 3, 3, "Exited"),
					makeGCContainer("foo", "bar", 2, 2, "Exited"),
					makeGCContainer("foo", "bar", 1, 1, "Exited"),
					makeGCContainer("foo", "bar", 0, 0, "Exited"),
				],
				policy: { minAgeMs: 60 * 1000, maxPerPodContainer: -1, maxContainers: 4 },
				remain: [0, 1, 2, 3],
				evictTerminatingPods: false,
				allSourcesReady: true,
			},
			{
				description:
					"no containers should be removed if both max container and per pod container limits are not set",
				containers: [
					makeGCContainer("foo", "bar", 2, 2, "Exited"),
					makeGCContainer("foo", "bar", 1, 1, "Exited"),
					makeGCContainer("foo", "bar", 0, 0, "Exited"),
				],
				policy: { minAgeMs: 60 * 1000, maxPerPodContainer: -1, maxContainers: -1 },
				remain: [0, 1, 2],
				evictTerminatingPods: false,
				allSourcesReady: true,
			},
			{
				description: "recently started containers should not be removed",
				containers: [
					makeGCContainer("foo", "bar", 2, clock.nowMs(), "Exited"),
					makeGCContainer("foo", "bar", 1, clock.nowMs(), "Exited"),
					makeGCContainer("foo", "bar", 0, clock.nowMs(), "Exited"),
				],
				remain: [0, 1, 2],
				evictTerminatingPods: false,
				allSourcesReady: true,
			},
			{
				description: "oldest containers should be removed when per pod container limit exceeded",
				containers: [
					makeGCContainer("foo", "bar", 2, 2, "Exited"),
					makeGCContainer("foo", "bar", 1, 1, "Exited"),
					makeGCContainer("foo", "bar", 0, 0, "Exited"),
				],
				remain: [0, 1],
				evictTerminatingPods: false,
				allSourcesReady: true,
			},
			{
				description: "running containers should not be removed",
				containers: [
					makeGCContainer("foo", "bar", 2, 2, "Exited"),
					makeGCContainer("foo", "bar", 1, 1, "Exited"),
					makeGCContainer("foo", "bar", 0, 0, "Running"),
				],
				remain: [0, 1, 2],
				evictTerminatingPods: false,
				allSourcesReady: true,
			},
			{
				description: "no containers should be removed when limits are not exceeded",
				containers: [
					makeGCContainer("foo", "bar", 1, 1, "Exited"),
					makeGCContainer("foo", "bar", 0, 0, "Exited"),
				],
				remain: [0, 1],
				evictTerminatingPods: false,
				allSourcesReady: true,
			},
			{
				description: "max container count should apply per (UID, container) pair",
				containers: [
					makeGCContainer("foo", "bar", 2, 2, "Exited"),
					makeGCContainer("foo", "bar", 1, 1, "Exited"),
					makeGCContainer("foo", "bar", 0, 0, "Exited"),
					makeGCContainer("foo1", "baz", 2, 2, "Exited"),
					makeGCContainer("foo1", "baz", 1, 1, "Exited"),
					makeGCContainer("foo1", "baz", 0, 0, "Exited"),
					makeGCContainer("foo2", "bar", 2, 2, "Exited"),
					makeGCContainer("foo2", "bar", 1, 1, "Exited"),
					makeGCContainer("foo2", "bar", 0, 0, "Exited"),
				],
				remain: [0, 1, 3, 4, 6, 7],
				evictTerminatingPods: false,
				allSourcesReady: true,
			},
			{
				description: "max limit should apply and try to keep from every pod",
				containers: [
					makeGCContainer("foo", "bar", 1, 1, "Exited"),
					makeGCContainer("foo", "bar", 0, 0, "Exited"),
					makeGCContainer("foo1", "bar1", 1, 1, "Exited"),
					makeGCContainer("foo1", "bar1", 0, 0, "Exited"),
					makeGCContainer("foo2", "bar2", 1, 1, "Exited"),
					makeGCContainer("foo2", "bar2", 0, 0, "Exited"),
					makeGCContainer("foo3", "bar3", 1, 1, "Exited"),
					makeGCContainer("foo3", "bar3", 0, 0, "Exited"),
					makeGCContainer("foo4", "bar4", 1, 1, "Exited"),
					makeGCContainer("foo4", "bar4", 0, 0, "Exited"),
				],
				remain: [0, 2, 4, 6, 8],
				evictTerminatingPods: false,
				allSourcesReady: true,
			},
			{
				description: "oldest pods should be removed if limit exceeded",
				containers: [
					makeGCContainer("foo", "bar", 2, 2, "Exited"),
					makeGCContainer("foo", "bar", 1, 1, "Exited"),
					makeGCContainer("foo1", "bar1", 2, 2, "Exited"),
					makeGCContainer("foo1", "bar1", 1, 1, "Exited"),
					makeGCContainer("foo2", "bar2", 1, 1, "Exited"),
					makeGCContainer("foo3", "bar3", 0, 0, "Exited"),
					makeGCContainer("foo4", "bar4", 1, 1, "Exited"),
					makeGCContainer("foo5", "bar5", 0, 0, "Exited"),
					makeGCContainer("foo6", "bar6", 2, 2, "Exited"),
					makeGCContainer("foo7", "bar7", 1, 1, "Exited"),
				],
				remain: [0, 2, 4, 6, 8, 9],
				evictTerminatingPods: false,
				allSourcesReady: true,
			},
			{
				description:
					"all non-running containers should be removed when evictTerminatingPods is set",
				containers: [
					makeGCContainer("foo", "bar", 2, 2, "Exited"),
					makeGCContainer("foo", "bar", 1, 1, "Exited"),
					makeGCContainer("foo1", "bar1", 2, 2, "Exited"),
					makeGCContainer("foo1", "bar1", 1, 1, "Exited"),
					makeGCContainer("running", "bar2", 1, 1, "Exited"),
					makeGCContainer("foo3", "bar3", 0, 0, "Running"),
				],
				remain: [4, 5],
				evictTerminatingPods: true,
				allSourcesReady: true,
			},
			{
				description: "containers for deleted pods should be removed",
				containers: [
					makeGCContainer("foo", "bar", 1, 1, "Exited"),
					makeGCContainer("foo", "bar", 0, 0, "Exited"),
					makeGCContainer("deleted", "bar1", 2, clock.nowMs(), "Exited"),
					makeGCContainer("deleted", "bar1", 1, 1, "Exited"),
					makeGCContainer("deleted", "bar1", 0, 0, "Exited"),
				],
				remain: [0, 1, 2],
				evictTerminatingPods: false,
				allSourcesReady: true,
			},
			{
				description:
					"containers for deleted pods may not be removed if allSourcesReady is set false ",
				containers: [makeGCContainer("deleted", "bar1", 0, 0, "Exited")],
				remain: [0],
				evictTerminatingPods: true,
				allSourcesReady: false,
			},
		];
		for (const test of tests) {
			podStateProvider.removed = new Set<string>();
			podStateProvider.terminated = new Set<string>();
			const fakeContainers = await makeFakeContainers(tCtx, m, test.containers);
			for (const s of test.containers) {
				if (s.pod.metadata?.name === "deleted") {
					podStateProvider.removed.add(s.pod.metadata.uid ?? "");
				}
				if (s.pod.metadata?.name !== "running") {
					podStateProvider.terminated.add(s.pod.metadata?.uid ?? "");
				}
			}
			fakeRuntime.setFakeContainers(fakeContainers);

			const gcErr = await m.containerGC.evictContainers(
				tCtx,
				test.policy ?? defaultGCPolicy,
				test.allSourcesReady,
				test.evictTerminatingPods,
			);
			expect(gcErr).toBeUndefined();
			const [realRemain, remainErr] = await fakeRuntime.listContainers(tCtx);
			expect(remainErr).toBeUndefined();
			expect(realRemain).toHaveLength(test.remain.length);
			for (const remain of test.remain) {
				const [resp, statusErr] = await fakeRuntime.containerStatus(
					tCtx,
					fakeContainers[remain]?.id ?? "",
				);
				expect(statusErr).toBeUndefined();
				expect(resp?.status?.id).toBe(fakeContainers[remain]?.id);
			}
		}
	});
});

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc_test.go TestPodLogDirectoryGC.
browser.describe("podLogDirectoryGC", () => {
	it("is a no-op because the simulator does not model kubelet log files", async () => {
		const tCtx = context.background();
		const [, , m, err] = createTestRuntimeManager(tCtx);
		expect(err).toBeUndefined();

		expect(await m.containerGC.evictPodLogsDirectories(tCtx, true)).toBeUndefined();
		expect(await m.containerGC.evictPodLogsDirectories(tCtx, false)).toBeUndefined();
	});
});

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc_test.go TestUnknownStateContainerGC.
browser.describe("unknownStateContainerGC", () => {
	it("stops unknown containers before removing them", async () => {
		const tCtx = context.background();
		const [fakeRuntime, , m, err] = createTestRuntimeManager(tCtx);
		expect(err).toBeUndefined();

		const defaultGCPolicy = { minAgeMs: 60 * 60 * 1000, maxPerPodContainer: 0, maxContainers: 0 };
		const fakeContainers = await makeFakeContainers(tCtx, m, [
			makeGCContainer("foo", "bar", 0, 0, "Unknown"),
		]);
		fakeRuntime.setFakeContainers(fakeContainers);

		const gcErr = await m.containerGC.evictContainers(tCtx, defaultGCPolicy, true, false);
		expect(gcErr).toBeUndefined();
		expect(fakeRuntime.getCalls()).toContain("StopContainer");
		expect(fakeRuntime.getCalls()).toContain("RemoveContainer");
		const [remain, remainErr] = await fakeRuntime.listContainers(tCtx);
		expect(remainErr).toBeUndefined();
		expect(remain).toEqual([]);
	});
});

function makeGCContainer(
	podName: string,
	containerName: string,
	attempt: number,
	createdAt: number,
	state: CRIContainerStatus["state"],
): ContainerTemplate {
	const container = makeTestContainer(containerName, "test-image");
	const pod = makeTestPod(podName, "test-ns", podName, [container]);
	return { pod, container, attempt, createdAt, state };
}

interface SandboxGCTestCase {
	description: string;
	sandboxes: SandboxTemplate[];
	containers: ContainerTemplate[];
	remain: number[];
	evictTerminatingPods: boolean;
}

interface ContainerGCTestCase {
	description: string;
	containers: ContainerTemplate[];
	policy?: { minAgeMs: number; maxPerPodContainer: number; maxContainers: number };
	remain: number[];
	evictTerminatingPods: boolean;
	allSourcesReady: boolean;
}
