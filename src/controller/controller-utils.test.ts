// oxlint-disable vitest/no-conditional-expect
/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import type { KubernetesObject, V1Pod, V1PodTemplateSpec } from "../client";
import { newControllerRef } from "../apimachinery/pkg/apis/meta/v1/controller_ref";
import { GroupVersion } from "../apimachinery/pkg/runtime/schema/group_version";
import { newTestKubeClient } from "../client/test";
import { TTLPolicy } from "../client-go/tools/cache/expiration-cache";
import { newFakeExpirationStore } from "../client-go/tools/cache/expiration-cache-fakes";
import { newFakeRecorder } from "../client-go/tools/record/fake";
import { Clock } from "../clock";
import { withClock } from "../clock-context";
import * as context from "../go/context";
import { WaitGroup } from "../go/sync/wait-group";
import { browser } from "../test/describe";
import { newFakePassiveClock } from "../utils/clock/testing/fake-clock";
import {
	ActivePodsWithRanks,
	type ControllerExpectations,
	computeHash,
	expKeyFunc,
	findMinNextPodAvailabilitySimpleCheck,
	findMinNextPodAvailabilityCheck,
	keyFunc,
	nextPodAvailabilityCheck,
	newControllerExpectations,
	newUIDTrackingControllerExpectations,
	podKey,
	RealPodControl,
} from "./controller-utils";

// Models kubernetes/pkg/controller/controller_utils_test.go NewFakeControllerExpectationsLookup.
function newFakeControllerExpectationsLookup(ttl: number): [ControllerExpectations, Clock] {
	const fakeClock = new Clock();
	fakeClock.pause();
	const ctx = withClock(context.background(), fakeClock);
	const ttlPolicy = new TTLPolicy(ttl, fakeClock);
	const ttlStore = newFakeExpirationStore(expKeyFunc, undefined, ttlPolicy, fakeClock);
	const expectations = newControllerExpectations(ctx);
	expectations.store = ttlStore;
	return [expectations, fakeClock];
}

interface TestReplicationController extends KubernetesObject {
	spec: {
		replicas: number;
		selector: Record<string, string>;
		template: V1PodTemplateSpec;
	};
}

// Models kubernetes/pkg/controller/controller_utils_test.go newReplicationController.
function newReplicationController(replicas: number): TestReplicationController {
	return {
		apiVersion: "v1",
		kind: "ReplicationController",
		metadata: {
			uid: crypto.randomUUID(),
			name: "foobar",
			namespace: "default",
			resourceVersion: "18",
		},
		spec: {
			replicas,
			selector: { foo: "bar" },
			template: {
				metadata: {
					labels: {
						name: "foo",
						type: "production",
					},
				},
				spec: {
					containers: [{ name: "", image: "foo/bar" }],
					restartPolicy: "Always",
					dnsPolicy: "Default",
					nodeSelector: {
						baz: "blah",
					},
				},
			},
		},
	};
}

// Models kubernetes/pkg/controller/controller_utils_test.go newPodList.
function newPodList(
	_store: undefined,
	count: number,
	status: string,
	rc: TestReplicationController,
): V1Pod[] {
	const pods: V1Pod[] = [];
	for (let i = 0; i < count; i++) {
		const newPod: V1Pod = {
			metadata: {
				name: `pod${i}`,
				labels: rc.spec.selector,
				namespace: rc.metadata?.namespace,
			},
			status: { phase: status },
		};
		pods.push(newPod);
	}
	return pods;
}

browser.describe("controller utils", ({ ctx }) => {
	// Models kubernetes/pkg/controller/controller_utils_test.go TestControllerExpectations.
	it("ControllerExpectations", async () => {
		const ttl = 30 * 1000;
		const [e, fakeClock] = newFakeControllerExpectationsLookup(ttl);
		const adds = 10;
		const dels = 30;
		const rc = newReplicationController(1);

		// RC fires off adds and deletes at apiserver, then sets expectations
		const [rcKey, keyErr] = keyFunc(rc);
		expect(keyErr).toBeUndefined();

		await e.setExpectations(rcKey, adds, dels);
		const wg = new WaitGroup();
		const errors: unknown[] = [];
		for (let i = 0; i < adds + 1; i++) {
			wg.add(1);
			queueMicrotask(() => {
				void e
					.creationObserved(rcKey)
					.catch((error: unknown) => {
						errors.push(error);
					})
					.finally(() => {
						wg.done();
					});
			});
		}
		await wg.wait();
		if (errors.length > 0) {
			throw errors[0];
		}

		expect(e.satisfiedExpectations(rcKey)).toBe(false);

		for (let i = 0; i < dels + 1; i++) {
			wg.add(1);
			queueMicrotask(() => {
				void e
					.deletionObserved(rcKey)
					.catch((error: unknown) => {
						errors.push(error);
					})
					.finally(() => {
						wg.done();
					});
			});
		}
		await wg.wait();
		if (errors.length > 0) {
			throw errors[0];
		}

		const tests: Array<{
			name: string;
			expectationsToSet?: [number, number];
			expireExpectations: boolean;
			wantPodExpectations: [number, number];
			wantExpectationsSatisfied: boolean;
		}> = [
			{
				name: "Expectations have been surpassed",
				expireExpectations: false,
				wantPodExpectations: [-1, -1],
				wantExpectationsSatisfied: true,
			},
			{
				name: "Old expectations are cleared because of ttl",
				expectationsToSet: [1, 2],
				expireExpectations: true,
				wantPodExpectations: [1, 2],
				wantExpectationsSatisfied: false,
			},
		];

		for (const test of tests) {
			if (test.expectationsToSet) {
				await e.setExpectations(rcKey, test.expectationsToSet[0], test.expectationsToSet[1]);
			}
			const [podExp, exists, err] = e.getExpectations(rcKey);
			expect(err).toBeUndefined();
			expect(exists).toBe(true);
			expect({ name: test.name, expectations: podExp?.getExpectations() }).toEqual({
				name: test.name,
				expectations: test.wantPodExpectations,
			});
			expect({ name: test.name, satisfied: e.satisfiedExpectations(rcKey) }).toEqual({
				name: test.name,
				satisfied: test.wantExpectationsSatisfied,
			});

			if (test.expireExpectations) {
				fakeClock.step(ttl + 1);
				expect(e.satisfiedExpectations(rcKey)).toBe(true);
			}
		}
	});

	// Models kubernetes/pkg/controller/controller_utils_test.go TestUIDExpectations.
	it("UIDExpectations", async () => {
		const uidExp = newUIDTrackingControllerExpectations(newControllerExpectations(ctx));
		type TestCase = {
			name: string;
			numReplicas: number;
		};

		const shuffleTests = (tests: TestCase[]): void => {
			for (let i = 0; i < tests.length; i++) {
				const j = Math.floor(Math.random() * (i + 1));
				const test = tests[i];
				const swap = tests[j];
				if (test && swap) {
					tests[i] = swap;
					tests[j] = test;
				}
			}
		};

		const getRcDataFrom = async (test: TestCase): Promise<[string, string[]]> => {
			const rc = newReplicationController(test.numReplicas);

			const rcName = `rc-${test.numReplicas}`;
			if (rc.metadata) {
				rc.metadata.name = rcName;
			}
			rc.spec.selector[rcName] = rcName;

			const podList = newPodList(undefined, 5, "Running", rc);
			const [rcKey, err] = keyFunc(rc);
			if (err) {
				throw new Error(`Couldn't get key for object ${JSON.stringify(rc)}: ${err.message}`);
			}

			const rcPodNames: string[] = [];
			for (const p of podList) {
				p.metadata ??= {};
				p.metadata.name = `${p.metadata.name}-${rc.metadata?.name ?? ""}`;
				rcPodNames.push(podKey(p));
			}
			await uidExp.expectDeletions(rcKey, rcPodNames);
			return [rcKey, rcPodNames];
		};

		const tests: TestCase[] = [
			{ name: "Replication controller with 2 replicas", numReplicas: 2 },
			{ name: "Replication controller with 1 replica", numReplicas: 1 },
			{ name: "Replication controller with no replicas", numReplicas: 0 },
			{ name: "Replication controller with 5 replicas", numReplicas: 5 },
		];

		shuffleTests(tests);
		for (const test of tests) {
			const [rcKey, rcPodNames] = await getRcDataFrom(test);
			expect({ name: test.name, satisfied: uidExp.satisfiedExpectations(rcKey) }).toEqual({
				name: test.name,
				satisfied: false,
			});

			for (const p of rcPodNames) {
				await uidExp.deletionObserved(rcKey, p);
			}

			expect({ name: test.name, satisfied: uidExp.satisfiedExpectations(rcKey) }).toEqual({
				name: test.name,
				satisfied: true,
			});

			await uidExp.deleteExpectations(rcKey);

			expect({ name: test.name, uids: uidExp.getUIDs(rcKey) }).toEqual({
				name: test.name,
				uids: undefined,
			});
		}
	});

	// Models kubernetes/pkg/controller/controller_utils_test.go TestCreatePodsWithGenerateName.
	it("CreatePodsWithGenerateName", async () => {
		const namespace = "default";
		const generateName = "hello-";
		const controllerSpec = newReplicationController(1);
		const controllerRef = newControllerRef(
			controllerSpec,
			new GroupVersion("", "v1").withKind("ReplicationController"),
		);

		type TestCase = {
			name: string;
			podCreationFunc: (podControl: RealPodControl) => Promise<Error | undefined>;
			wantPod: V1Pod;
		};
		const tests: TestCase[] = [
			{
				name: "Create pod",
				podCreationFunc: async (podControl) =>
					await podControl.createPods(
						ctx,
						namespace,
						controllerSpec.spec?.template ?? {},
						controllerSpec,
						controllerRef,
					),
				wantPod: {
					metadata: {
						labels: controllerSpec.spec?.template?.metadata?.labels,
						generateName: `${controllerSpec.metadata?.name}-`,
					},
					spec: controllerSpec.spec?.template?.spec,
				},
			},
			{
				name: "Create pod with generate name",
				podCreationFunc: async (podControl) =>
					await podControl.createPodsWithGenerateName(
						ctx,
						namespace,
						controllerSpec.spec?.template ?? {},
						controllerSpec,
						controllerRef,
						generateName,
					),
				wantPod: {
					metadata: {
						labels: controllerSpec.spec?.template?.metadata?.labels,
						generateName,
						ownerReferences: [controllerRef],
					},
					spec: controllerSpec.spec?.template?.spec,
				},
			},
		];

		for (const test of tests) {
			const [client] = await newTestKubeClient(ctx, [
				{ apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } },
			]);
			let callbackCalled = false;
			const podControl = new RealPodControl(client.corev1, newFakeRecorder(10), () => {
				callbackCalled = true;
			});

			const err = await test.podCreationFunc(podControl);
			expect(err).toBeUndefined();
			expect({ name: test.name, callbackCalled }).toEqual({
				name: test.name,
				callbackCalled: true,
			});

			const pods = await client.corev1.listNamespacedPod({ namespace });
			expect({ name: test.name, podCount: pods.items.length }).toEqual({
				name: test.name,
				podCount: 1,
			});
			expect({ name: test.name, pod: pods.items[0] }).toMatchObject({
				name: test.name,
				pod: test.wantPod,
			});
		}
	});

	// Models kubernetes/pkg/controller/controller_utils_test.go TestPatchPodCallbacks.
	it("PatchPodCallbacks", async () => {
		const [client] = await newTestKubeClient(ctx, [
			{
				apiVersion: "v1",
				kind: "Pod",
				metadata: { name: "test-pod", namespace: "default" },
				spec: { containers: [{ name: "main", image: "image" }] },
			},
		]);
		let wroteCallbackCalled = false;
		const podControl = new RealPodControl(client.corev1, newFakeRecorder(10), () => {
			wroteCallbackCalled = true;
		});

		const patchBytes = new TextEncoder().encode("{}");
		const notFoundErr = await podControl.patchPod(ctx, "default", "non-existing-pod", patchBytes);
		expect(wroteCallbackCalled).toBe(false);
		expect(notFoundErr).toMatchObject({ code: 404 });

		const err = await podControl.patchPod(ctx, "default", "test-pod", patchBytes);
		expect(wroteCallbackCalled).toBe(true);
		expect(err).toBeUndefined();
	});

	// Models kubernetes/pkg/controller/controller_utils_test.go TestDeletePodsAllowsMissing.
	it("DeletePodsAllowsMissing", async () => {
		const [client] = await newTestKubeClient(ctx);
		const podControl = new RealPodControl(client.corev1, newFakeRecorder(10));
		const controllerSpec = newReplicationController(1);

		const err = await podControl.deletePod(ctx, "namespace-name", "podName", controllerSpec);
		expect(err).toMatchObject({ code: 404 });
	});

	// Models kubernetes/pkg/controller/controller_utils_test.go TestNextPodAvailabilityCheck.
	it("NextPodAvailabilityCheck", () => {
		const newPodWithReadyCond = (now: Date, ready: boolean, beforeSec: number): V1Pod => ({
			status: {
				conditions: [
					{
						type: "Ready",
						lastTransitionTime: new Date(now.getTime() - beforeSec * 1000),
						status: ready ? "True" : "False",
					},
				],
			},
		});

		const now = new Date();
		const tests: Array<{
			name: string;
			pod: V1Pod;
			minReadySeconds: number;
			expected: number | undefined;
		}> = [
			{
				name: "not ready",
				pod: newPodWithReadyCond(now, false, 0),
				minReadySeconds: 0,
				expected: undefined,
			},
			{
				name: "no minReadySeconds defined",
				pod: newPodWithReadyCond(now, true, 0),
				minReadySeconds: 0,
				expected: undefined,
			},
			{
				name: "lastTransitionTime is zero",
				pod: { status: { conditions: [{ type: "Ready", status: "True" }] } },
				minReadySeconds: 1,
				expected: undefined,
			},
			{
				name: "just became ready - available in 1s",
				pod: newPodWithReadyCond(now, true, 0),
				minReadySeconds: 1,
				expected: 1000,
			},
			{
				name: "ready for 20s - available in 10s",
				pod: newPodWithReadyCond(now, true, 20),
				minReadySeconds: 30,
				expected: 10_000,
			},
			{
				name: "available",
				pod: newPodWithReadyCond(now, true, 51),
				minReadySeconds: 50,
				expected: undefined,
			},
		];

		for (const test of tests) {
			const nextAvailable = nextPodAvailabilityCheck(test.pod, test.minReadySeconds, now);
			expect({ name: test.name, nextAvailable }).toEqual({
				name: test.name,
				nextAvailable: test.expected,
			});
		}
	});

	// Models kubernetes/pkg/controller/controller_utils_test.go TestFindMinNextPodAvailabilitySimpleCheck.
	it("FindMinNextPodAvailabilitySimpleCheck", () => {
		const clock = new Clock();
		clock.pause();
		const now = clock.now();
		const pod = (name: string, ready: boolean, beforeSec: number): V1Pod => ({
			metadata: { name },
			status: {
				conditions: [
					{
						type: "Ready",
						status: ready ? "True" : "False",
						lastTransitionTime: new Date(now.getTime() - beforeSec * 1000),
					},
				],
			},
		});

		const tests: Array<{
			name: string;
			pods: V1Pod[];
			minReadySeconds: number;
			expected: number | undefined;
			expectedPod: string | undefined;
		}> = [
			{
				name: "no pods",
				pods: [],
				minReadySeconds: 0,
				expected: undefined,
				expectedPod: undefined,
			},
			{
				name: "unready pods",
				pods: [pod("pod1", false, 0), pod("pod2", false, 0)],
				minReadySeconds: 0,
				expected: undefined,
				expectedPod: undefined,
			},
			{
				name: "ready pods with no minReadySeconds",
				pods: [pod("pod1", true, 0), pod("pod2", true, 0)],
				minReadySeconds: 0,
				expected: undefined,
				expectedPod: undefined,
			},
			{
				name: "unready and ready pods should find min next availability check",
				pods: [
					pod("pod1", false, 0),
					pod("pod2", true, 2),
					pod("pod3", true, 0),
					pod("pod4", true, 4),
					pod("pod5", false, 0),
				],
				minReadySeconds: 10,
				expected: 6000,
				expectedPod: "pod4",
			},
			{
				name: "unready and available pods do not require min next availability check",
				pods: [
					pod("pod1", false, 0),
					pod("pod2", true, 15),
					pod("pod3", true, 11),
					pod("pod4", true, 10),
					pod("pod5", false, 0),
				],
				minReadySeconds: 10,
				expected: undefined,
				expectedPod: undefined,
			},
		];

		for (const test of tests) {
			const [nextAvailable, checkPod] = findMinNextPodAvailabilitySimpleCheck(
				test.pods,
				test.minReadySeconds,
				now,
			);
			expect({
				name: test.name,
				nextAvailable,
				checkPodName: checkPod?.metadata?.name,
			}).toEqual({
				name: test.name,
				nextAvailable: test.expected,
				checkPodName: test.expectedPod,
			});

			const nextAvailableFromPublicCheck = findMinNextPodAvailabilityCheck(
				test.pods,
				test.minReadySeconds,
				now,
				clock,
			);
			expect({
				name: test.name,
				nextAvailable: nextAvailableFromPublicCheck,
			}).toEqual({
				name: test.name,
				nextAvailable: test.expected,
			});
		}
	});

	// Models kubernetes/pkg/controller/controller_utils_test.go TestFindMinNextPodAvailability.
	it("FindMinNextPodAvailability", () => {
		const now = new Date();
		const pod = (name: string, ready: boolean, beforeSec: number): V1Pod => ({
			metadata: { name },
			status: {
				conditions: [
					{
						type: "Ready",
						status: ready ? "True" : "False",
						lastTransitionTime: new Date(now.getTime() - beforeSec * 1000),
					},
				],
			},
		});

		const tests: Array<{
			name: string;
			pods: V1Pod[];
			minReadySeconds: number;
			statusEvaluationDelaySeconds: number;
			expected: number | undefined;
		}> = [
			{
				name: "unready and ready pods should find min next availability check considering status evaluation/update delay",
				pods: [
					pod("pod1", false, 0),
					pod("pod2", true, 2),
					pod("pod3", true, 0),
					pod("pod4", true, 4),
					pod("pod5", false, 0),
				],
				minReadySeconds: 10,
				statusEvaluationDelaySeconds: 2,
				expected: 4000,
			},
			{
				name: "unready and ready pods should find min next availability check even if the status evaluation delay is longer than minReadySeconds",
				pods: [
					pod("pod1", false, 0),
					pod("pod2", true, 2),
					pod("pod3", true, 0),
					pod("pod4", true, 4),
					pod("pod5", false, 0),
				],
				minReadySeconds: 10,
				statusEvaluationDelaySeconds: 7,
				expected: 0,
			},
		];

		for (const test of tests) {
			const oldNow = now;
			const newNow = newFakePassiveClock(
				new Date(now.getTime() + test.statusEvaluationDelaySeconds * 1000),
			);
			const nextAvailable = findMinNextPodAvailabilityCheck(
				test.pods,
				test.minReadySeconds,
				oldNow,
				newNow,
			);

			expect({ name: test.name, nextAvailable }).toEqual({
				name: test.name,
				nextAvailable: test.expected,
			});
		}
	});

	// Models kubernetes/pkg/controller/controller_utils_test.go TestSortingActivePodsWithRanks.
	it("SortingActivePodsWithRanks", () => {
		const now = new Date("2026-01-01T00:00:00.000Z");
		const then1Month = new Date("2025-12-01T00:00:00.000Z");
		const then2Hours = new Date(now.getTime() - 2 * 60 * 60 * 1000);
		const then5Hours = new Date(now.getTime() - 5 * 60 * 60 * 1000);
		const then8Hours = new Date(now.getTime() - 8 * 60 * 60 * 1000);
		const zeroTime = undefined;
		const pod = (
			podName: string,
			nodeName: string,
			phase: string,
			ready: boolean,
			restarts: number,
			sideRestarts: number,
			readySince: Date | undefined,
			created: Date | undefined,
			annotations?: Record<string, string>,
		): V1Pod => ({
			metadata: {
				creationTimestamp: created,
				name: podName,
				annotations,
			},
			spec: {
				containers: [],
				nodeName,
				initContainers: [{ name: "sidecar", restartPolicy: "Always" }],
			},
			status: {
				conditions: ready
					? [{ type: "Ready", status: "True", lastTransitionTime: readySince }]
					: undefined,
				containerStatuses: ready
					? [
							{
								image: "image",
								imageID: "image",
								name: "container",
								ready: true,
								restartCount: restarts,
							},
						]
					: undefined,
				initContainerStatuses: ready
					? [
							{
								image: "image",
								imageID: "image",
								name: "sidecar",
								ready: true,
								restartCount: sideRestarts,
							},
						]
					: undefined,
				phase,
			},
		});
		const unscheduledPod = pod("unscheduled", "", "Pending", false, 0, 0, zeroTime, zeroTime);
		const scheduledPendingPod = pod("pending", "node", "Pending", false, 0, 0, zeroTime, zeroTime);
		const unknownPhasePod = pod(
			"unknown-phase",
			"node",
			"Unknown",
			false,
			0,
			0,
			zeroTime,
			zeroTime,
		);
		const runningNotReadyPod = pod("not-ready", "node", "Running", false, 0, 0, zeroTime, zeroTime);
		const runningReadyNoLastTransitionTimePod = pod(
			"ready-no-last-transition-time",
			"node",
			"Running",
			true,
			0,
			0,
			zeroTime,
			zeroTime,
		);
		const runningReadyNow = pod("ready-now", "node", "Running", true, 0, 0, now, now);
		const runningReadyThen = pod(
			"ready-then",
			"node",
			"Running",
			true,
			0,
			0,
			then1Month,
			then1Month,
		);
		const runningReadyNowHighRestarts = pod(
			"ready-high-restarts",
			"node",
			"Running",
			true,
			9001,
			0,
			now,
			now,
		);
		const runningReadyNowHighSideRestarts = pod(
			"ready-high-side-restarts",
			"node",
			"Running",
			true,
			9001,
			9001,
			now,
			now,
		);
		const runningReadyNowCreatedThen = pod(
			"ready-now-created-then",
			"node",
			"Running",
			true,
			0,
			0,
			now,
			then1Month,
		);
		const lowPodDeletionCost = pod(
			"low-deletion-cost",
			"node",
			"Running",
			true,
			0,
			0,
			now,
			then1Month,
			{ "controller.kubernetes.io/pod-deletion-cost": "10" },
		);
		const highPodDeletionCost = pod(
			"high-deletion-cost",
			"node",
			"Running",
			true,
			0,
			0,
			now,
			then1Month,
			{ "controller.kubernetes.io/pod-deletion-cost": "100" },
		);
		const ready2Hours = pod("ready-2-hours", "", "Running", true, 0, 0, then2Hours, then1Month);
		const ready5Hours = pod("ready-5-hours", "", "Running", true, 0, 0, then5Hours, then1Month);
		const ready10Hours = pod("ready-10-hours", "", "Running", true, 0, 0, then8Hours, then1Month);
		const equalityTests: Array<{ p1: V1Pod; p2?: V1Pod }> = [
			{ p1: unscheduledPod },
			{ p1: scheduledPendingPod },
			{ p1: unknownPhasePod },
			{ p1: runningNotReadyPod },
			{ p1: runningReadyNowCreatedThen },
			{ p1: runningReadyNow },
			{ p1: runningReadyThen },
			{ p1: runningReadyNowHighRestarts },
			{ p1: runningReadyNowCreatedThen },
			{ p1: ready5Hours, p2: ready10Hours },
		];
		for (const [index, test] of equalityTests.entries()) {
			const podsWithRanks = new ActivePodsWithRanks([test.p1, test.p2 ?? test.p1], [1, 1], now);
			expect({
				leftLess: podsWithRanks.less(0, 1),
				rightLess: podsWithRanks.less(1, 0),
				name: `Equality tests ${index}`,
			}).toEqual({ leftLess: false, rightLess: false, name: `Equality tests ${index}` });
		}

		const inequalityTests: Array<{
			lesser: [V1Pod, number];
			greater: [V1Pod, number];
		}> = [
			{ lesser: [unscheduledPod, 1], greater: [scheduledPendingPod, 2] },
			{ lesser: [unscheduledPod, 2], greater: [scheduledPendingPod, 1] },
			{ lesser: [scheduledPendingPod, 1], greater: [unknownPhasePod, 2] },
			{ lesser: [unknownPhasePod, 1], greater: [runningNotReadyPod, 2] },
			{ lesser: [runningNotReadyPod, 1], greater: [runningReadyNoLastTransitionTimePod, 1] },
			{ lesser: [runningReadyNoLastTransitionTimePod, 1], greater: [runningReadyNow, 1] },
			{ lesser: [runningReadyNow, 2], greater: [runningReadyNoLastTransitionTimePod, 1] },
			{ lesser: [runningReadyNow, 1], greater: [runningReadyThen, 1] },
			{ lesser: [runningReadyNow, 2], greater: [runningReadyThen, 1] },
			{ lesser: [runningReadyNowHighRestarts, 1], greater: [runningReadyNow, 1] },
			{ lesser: [runningReadyNowHighSideRestarts, 1], greater: [runningReadyNowHighRestarts, 1] },
			{ lesser: [runningReadyNow, 2], greater: [runningReadyNowHighRestarts, 1] },
			{ lesser: [runningReadyNow, 1], greater: [runningReadyNowCreatedThen, 1] },
			{ lesser: [runningReadyNowCreatedThen, 2], greater: [runningReadyNow, 1] },
			{ lesser: [lowPodDeletionCost, 2], greater: [highPodDeletionCost, 1] },
			{ lesser: [ready2Hours, 1], greater: [ready5Hours, 1] },
		];
		for (const [index, test] of inequalityTests.entries()) {
			const podsWithRanks = new ActivePodsWithRanks(
				[test.lesser[0], test.greater[0]],
				[test.lesser[1], test.greater[1]],
				now,
			);
			expect({
				leftLess: podsWithRanks.less(0, 1),
				rightLess: podsWithRanks.less(1, 0),
				name: `Inequality tests ${index}`,
			}).toEqual({ leftLess: true, rightLess: false, name: `Inequality tests ${index}` });
		}
	});

	// Models kubernetes/pkg/controller/controller_utils_test.go TestComputeHash.
	it("ComputeHash", () => {
		const collisionCount = 1;
		const otherCollisionCount = 2;
		const maxCollisionCount = 2147483647;
		const tests: Array<{
			name: string;
			template: V1PodTemplateSpec;
			collisionCount?: number;
			otherCollisionCount?: number;
		}> = [
			{
				name: "simple",
				template: {},
				collisionCount,
				otherCollisionCount,
			},
			{
				name: "using math.MaxInt64",
				template: {},
				collisionCount: undefined,
				otherCollisionCount: maxCollisionCount,
			},
		];

		for (const test of tests) {
			const hash = computeHash(test.template, test.collisionCount);
			const otherHash = computeHash(test.template, test.otherCollisionCount);
			expect({ name: test.name, sameHash: hash === otherHash }).toEqual({
				name: test.name,
				sameHash: false,
			});
		}
	});
});
