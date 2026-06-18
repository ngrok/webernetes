// oxlint-disable typescript/no-non-null-assertion vitest/no-conditional-expect
/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import type { V1Pod, V1ReplicaSet, V1ReplicaSetCondition, V1ReplicaSetStatus } from "../../client";
import { KubeConfig } from "../../client/config";
import { newTestKubeClient, TestKubeClient, type TestKubeClientObject } from "../../client/test";
import { getClock } from "../../clock-context";
import { Etcd } from "../../cluster/etcd";
import { DeletedFinalStateUnknown, splitMetaNamespaceKey } from "../../client-go/tools/cache/store";
import { newTypedMaxOfRateLimiter } from "../../client-go/util/workqueue/default-rate-limiters";
import { newTypedRateLimitingQueue } from "../../client-go/util/workqueue/rate-limiting-queue";
import { Channel, select } from "../../go/channel";
import * as context from "../../go/context";
import { Mutex } from "../../go/sync/mutex";
import * as time from "../../go/time";
import { browser } from "../../test/describe";
import { FakePodControl, keyFunc, podKey } from "../controller-utils";
import {
	calculateStatus,
	defaultReplicaSetControllerFeatures,
	getCondition,
	getPodKeys,
	getPodsToDelete,
	removeCondition,
	ReplicaSetController,
	setCondition,
	slowStartBatch,
	updateReplicaSetStatus,
	type ReplicaSetControllerFeatures,
} from "./replica-set";

let uidCounter = 0;

// Models kubernetes/pkg/controller/testutil/test_utils.go GetKey.
function getKey(obj: V1ReplicaSet): string {
	const [key, err] = keyFunc(obj);
	expect(err).toBeUndefined();
	return key;
}

// Models kubernetes/pkg/controller/replicaset/replica_set_test.go testNewReplicaSetControllerFromClient.
function newTestReplicaSetController(ctx: context.Context): ReplicaSetController {
	const kubeConfig = new KubeConfig({
		ctx,
		etcd: new Etcd(ctx),
		nodePortRange: { from: 30000, to: 32767 },
	});
	return new ReplicaSetController(new TestKubeClient(kubeConfig), kubeConfig);
}

// Normalizes upstream-shaped test objects before seeding the shared test client.
async function newSeededTestReplicaSetController(
	ctx: context.Context,
	objects: TestKubeClientObject[] = [],
	podControl?: FakePodControl,
): Promise<[ReplicaSetController, TestKubeClient]> {
	const seedObjects = objects.map((object) => {
		const seedObject = structuredClone(object);
		seedObject.metadata = { ...seedObject.metadata, resourceVersion: undefined };
		if (seedObject.kind === "ReplicaSet") {
			const replicaSet = seedObject as V1ReplicaSet;
			replicaSet.apiVersion = "apps/v1";
			replicaSet.spec ??= { selector: {} };
			replicaSet.spec.template ??= {};
			replicaSet.spec.template.metadata ??= {};
			replicaSet.spec.template.metadata.labels = {
				...(replicaSet.spec.template.metadata.labels ?? {}),
				...(replicaSet.spec.selector.matchLabels ?? {}),
			};
		}
		if (!seedObject.kind) {
			seedObject.apiVersion = "v1";
			seedObject.kind = "Pod";
		}
		if (seedObject.kind === "Pod") {
			const pod = seedObject as V1Pod;
			pod.spec ??= {
				containers: [
					{
						name: "container",
						image: "foo/bar",
					},
				],
			};
		}
		return seedObject;
	});
	const [client, kubeConfig] = await newTestKubeClient(ctx, seedObjects);
	return [
		new ReplicaSetController(
			client,
			kubeConfig,
			defaultReplicaSetControllerFeatures(),
			undefined,
			podControl,
		),
		client,
	];
}

// Models kubernetes/pkg/controller/replicaset/replica_set_test.go informer ReplicaSet store seeding.
async function addReplicaSet(manager: ReplicaSetController, rs: V1ReplicaSet): Promise<void> {
	await manager.rsIndexer.add(rs);
}

// Models kubernetes/pkg/controller/replicaset/replica_set_test.go informer Pod store seeding.
async function addPod(manager: ReplicaSetController, pod: V1Pod): Promise<void> {
	await manager.podIndexer.add(pod);
}

// Models kubernetes/pkg/controller/replicaset/replica_set_test.go validateSyncReplicaSet.
function validateSyncReplicaSet(
	fakePodControl: FakePodControl,
	expectedCreates: number,
	expectedDeletes: number,
	expectedPatches: number,
): Error | undefined {
	const actualCreates = fakePodControl.templates.length;
	if (expectedCreates !== actualCreates) {
		return new Error(
			`Unexpected number of creates. Expected ${expectedCreates}, saw ${actualCreates}`,
		);
	}

	const actualDeletes = fakePodControl.deletePodName.length;
	if (expectedDeletes !== actualDeletes) {
		return new Error(
			`Unexpected number of deletes. Expected ${expectedDeletes}, saw ${actualDeletes}`,
		);
	}

	const actualPatches = fakePodControl.patches.length;
	if (expectedPatches !== actualPatches) {
		return new Error(
			`Unexpected number of patches. Expected ${expectedPatches}, saw ${actualPatches}`,
		);
	}

	return undefined;
}

function firstPod(pods: V1Pod[]): V1Pod {
	const pod = pods[0];
	if (!pod) {
		throw new Error("expected at least one pod");
	}
	return pod;
}

// Models kubernetes/pkg/controller/replicaset/replica_set_test.go shuffle.
function shuffle(controllers: V1ReplicaSet[]): V1ReplicaSet[] {
	return [...controllers].reverse();
}

// Models kubernetes/pkg/controller/replicaset/replica_set_test.go newReplicaSet.
function newReplicaSet(replicas: number, selectorMap: Record<string, string>): V1ReplicaSet {
	const isController = true;
	const rs: V1ReplicaSet = {
		apiVersion: "v1",
		kind: "ReplicaSet",
		metadata: {
			uid: `uid-${++uidCounter}`,
			name: "foobar",
			namespace: "default",
			ownerReferences: [
				{ uid: "123", controller: isController, apiVersion: "", kind: "", name: "" },
			],
			resourceVersion: "18",
		},
		spec: {
			replicas,
			selector: { matchLabels: selectorMap },
			template: {
				metadata: {
					labels: {
						name: "foo",
						type: "production",
					},
				},
				spec: {
					containers: [
						{
							name: "",
							image: "foo/bar",
							terminationMessagePath: "/dev/termination-log",
							imagePullPolicy: "IfNotPresent",
							securityContext: {},
						},
					],
					restartPolicy: "Always",
					dnsPolicy: "Default",
					nodeSelector: {
						baz: "blah",
					},
				},
			},
		},
		status: { replicas: 0 },
	};
	return rs;
}

// Models kubernetes/pkg/controller/replicaset/replica_set_test.go newPodList.
function newPodList(
	count: number,
	status: string,
	labelMap: Record<string, string>,
	rs: V1ReplicaSet,
	name: string,
): V1Pod[] {
	const pods: V1Pod[] = [];
	const controllerReference = {
		uid: rs.metadata?.uid ?? "",
		apiVersion: "v1beta1",
		kind: "ReplicaSet",
		name: rs.metadata?.name ?? "",
		controller: true,
	};
	for (let i = 0; i < count; i++) {
		const pod = newPod(`${name}${i}`, rs, status, undefined, false);
		pod.metadata = {
			...pod.metadata,
			labels: labelMap,
			ownerReferences: [controllerReference],
		};
		pods.push(pod);
	}
	return pods;
}

// Models kubernetes/pkg/controller/replicaset/replica_set_test.go newPod.
function newPod(
	name: string,
	rs: V1ReplicaSet,
	status: string,
	lastTransitionTime: Date | undefined,
	properlyOwned: boolean,
): V1Pod {
	const conditions =
		status === "Running" ? [{ type: "Ready", status: "True", lastTransitionTime }] : undefined;
	const controllerReference = properlyOwned
		? {
				uid: rs.metadata?.uid ?? "",
				apiVersion: "v1beta1",
				kind: "ReplicaSet",
				name: rs.metadata?.name ?? "",
				controller: true,
			}
		: { uid: "", apiVersion: "", kind: "", name: "" };
	return {
		metadata: {
			uid: `uid-${++uidCounter}`,
			name,
			namespace: rs.metadata?.namespace,
			labels: rs.spec?.selector.matchLabels,
			ownerReferences: [controllerReference],
		},
		status: { phase: status, conditions },
	};
}

// Models kubernetes/pkg/controller/replicaset/replica_set_test.go ReplicaSet tests.
browser.describe("replicaset controller", ({ ctx }) => {
	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestSyncReplicaSetDoesNothing.
	it("TestSyncReplicaSetDoesNothing", async () => {
		const [client, kubeConfig] = await newTestKubeClient(ctx);
		const fakePodControl = new FakePodControl();
		const manager = new ReplicaSetController(
			client,
			kubeConfig,
			defaultReplicaSetControllerFeatures(),
			undefined,
			fakePodControl,
		);

		// 2 running pods, a controller with 2 replicas, sync is a no-op
		const labelMap = { foo: "bar" };
		const rsSpec = newReplicaSet(2, labelMap);
		const seedRS = structuredClone(rsSpec);
		seedRS.apiVersion = "apps/v1";
		seedRS.metadata = { ...seedRS.metadata, resourceVersion: undefined };
		seedRS.spec ??= { selector: {} };
		seedRS.spec.template ??= {};
		seedRS.spec.template.metadata ??= {};
		seedRS.spec.template.metadata.labels = {
			...(seedRS.spec.template.metadata.labels ?? {}),
			...(seedRS.spec.selector.matchLabels ?? {}),
		};
		await client.corev1.createNamespace({ body: { metadata: { name: "default" } } });
		await client.appsv1.createNamespacedReplicaSet({
			namespace: rsSpec.metadata?.namespace ?? "default",
			body: seedRS,
		});
		client.clearActions();
		await addReplicaSet(manager, rsSpec);
		const pods = newPodList(2, "Running", labelMap, rsSpec, "pod");
		for (const pod of pods) {
			await addPod(manager, pod);
		}

		await manager.syncReplicaSet(ctx, getKey(rsSpec));

		const err = validateSyncReplicaSet(fakePodControl, 0, 0, 0);
		expect(err).toBeUndefined();
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestDeleteFinalStateUnknown.
	it("TestDeleteFinalStateUnknown", async () => {
		const fakePodControl = new FakePodControl();
		const [manager] = await newSeededTestReplicaSetController(ctx, [], fakePodControl);

		let receiveKey!: (key: string) => void;
		const received = new Promise<string>((resolve) => {
			receiveKey = resolve;
		});
		manager.syncHandler = async (_ctx, key) => {
			receiveKey(key);
			return undefined;
		};

		const labelMap = { foo: "bar" };
		const rsSpec = newReplicaSet(1, labelMap);
		await addReplicaSet(manager, rsSpec);
		const pods = newPodList(1, "Running", labelMap, rsSpec, "pod");

		await manager.deletePod(ctx, new DeletedFinalStateUnknown("foo", pods[0]!));

		const expected = getKey(rsSpec);
		const processed = manager.processNextWorkItem(ctx);
		const clock = getClock(ctx);
		let timeoutHandle: number | undefined;
		const timeout = new Promise<undefined>((resolve) => {
			timeoutHandle = clock.setTimeout(() => resolve(undefined), 10_000);
		});
		const key = await Promise.race([received, timeout]);
		if (timeoutHandle !== undefined) {
			clock.clearTimeout(timeoutHandle);
		}
		if (key === undefined) {
			await manager.queue.shutDown();
			await processed;
			throw new Error("Processing DeleteFinalStateUnknown took longer than expected");
		}
		expect(key).toBe(expected);
		await processed;
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestSyncReplicaSetCreateFailures.
	it("TestSyncReplicaSetCreateFailures", async () => {
		const fakePodControl = new FakePodControl();
		fakePodControl.createLimit = 10;
		const labelMap = { foo: "bar" };
		const rs = newReplicaSet(fakePodControl.createLimit * 10, labelMap);
		const [manager] = await newSeededTestReplicaSetController(ctx, [rs], fakePodControl);
		await addReplicaSet(manager, rs);

		await manager.syncReplicaSet(ctx, getKey(rs));

		expect(
			validateSyncReplicaSet(fakePodControl, fakePodControl.createLimit, 0, 0),
		).toBeUndefined();

		let expectedLimit = 0;
		for (let pass = 0; expectedLimit <= fakePodControl.createLimit; pass++) {
			expectedLimit += 1 << pass;
		}
		expect(fakePodControl.createCallCount).toBeLessThanOrEqual(expectedLimit);
	});

	it("syncReplicaSet ignores NamespaceTerminating create failures", async () => {
		// Local coverage for kubernetes/pkg/controller/replicaset/replica_set.go manageReplicas.
		// Kubernetes 1.36 has this behavior in implementation code but no matching replica_set_test.go case.
		const labelMap = { foo: "bar" };
		const rs = newReplicaSet(1, labelMap);
		const fakePodControl = new FakePodControl();
		const namespaceTerminatingError = new Error("terminating namespace") as Error & {
			body: { details: { causes: Array<{ reason: string }> } };
		};
		namespaceTerminatingError.body = {
			details: {
				causes: [{ reason: "NamespaceTerminating" }],
			},
		};
		fakePodControl.err = namespaceTerminatingError;
		const [manager, client] = await newSeededTestReplicaSetController(ctx, [rs], fakePodControl);
		await addReplicaSet(manager, rs);
		client.clearActions();

		await expect(manager.syncReplicaSet(ctx, getKey(rs))).resolves.toBeUndefined();

		const updatedRS = await client.appsv1.readNamespacedReplicaSet({
			namespace: "default",
			name: "foobar",
		});
		expect(getCondition(updatedRS.status, "ReplicaFailure")).toBeUndefined();
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestSyncReplicaSetDormancy.
	it("TestSyncReplicaSetDormancy", async () => {
		const labelMap = { foo: "bar" };
		const rsSpec = newReplicaSet(2, labelMap);
		const pods = newPodList(1, "Running", labelMap, rsSpec, "pod");
		const fakePodControl = new FakePodControl();
		const [manager, client] = await newSeededTestReplicaSetController(
			ctx,
			[rsSpec, ...pods],
			fakePodControl,
		);
		await addReplicaSet(manager, rsSpec);
		await addPod(manager, pods[0]!);
		client.clearActions();

		const rsKey = getKey(rsSpec);

		rsSpec.status = {
			...(rsSpec.status ?? {}),
			replicas: 1,
			readyReplicas: 1,
			availableReplicas: 1,
			terminatingReplicas: 0,
		};
		await manager.rsIndexer.update(rsSpec);
		await manager.syncReplicaSet(ctx, rsKey);

		expect(validateSyncReplicaSet(fakePodControl, 1, 0, 0)).toBeUndefined();

		rsSpec.status = {
			...(rsSpec.status ?? {}),
			replicas: 0,
			readyReplicas: 0,
			availableReplicas: 0,
		};
		await manager.rsIndexer.update(rsSpec);
		client.clearActions();
		await fakePodControl.clear();
		await manager.syncReplicaSet(ctx, rsKey);

		expect(validateSyncReplicaSet(fakePodControl, 0, 0, 0)).toBeUndefined();

		await manager.expectations.creationObserved(rsKey);
		rsSpec.status = {
			...(rsSpec.status ?? {}),
			replicas: 1,
			readyReplicas: 1,
			availableReplicas: 1,
		};
		await manager.rsIndexer.update(rsSpec);
		await fakePodControl.clear();
		fakePodControl.err = new Error("fake Error");

		await manager.syncReplicaSet(ctx, rsKey);
		expect(validateSyncReplicaSet(fakePodControl, 1, 0, 0)).toBeUndefined();

		await fakePodControl.clear();
		fakePodControl.err = undefined;
		await manager.syncReplicaSet(ctx, rsKey);

		expect(validateSyncReplicaSet(fakePodControl, 1, 0, 0)).toBeUndefined();
		const statusUpdateActions = client
			.actions()
			.filter(
				(action) =>
					action.verb === "update" &&
					action.resource === "replicasets" &&
					action.subresource === "status",
			);
		expect(statusUpdateActions).toHaveLength(2);
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestGetReplicaSetsWithSameController.
	it("TestGetReplicaSetsWithSameController", async () => {
		const now = getClock(ctx).now();
		const someRS = newReplicaSet(1, { foo: "bar" });
		someRS.metadata!.name = "rs1";
		const relatedRS = newReplicaSet(1, { foo: "baz" });
		relatedRS.metadata!.name = "rs2";
		const unrelatedRS = newReplicaSet(1, { foo: "quux" });
		unrelatedRS.metadata!.name = "rs3";
		unrelatedRS.metadata!.ownerReferences![0].uid = "456";
		const pendingDeletionRS = newReplicaSet(1, { foo: "xyzzy" });
		pendingDeletionRS.metadata!.name = "rs4";
		pendingDeletionRS.metadata!.ownerReferences![0].uid = "789";
		pendingDeletionRS.metadata!.deletionTimestamp = now;

		const testCases: Array<{
			name: string;
			rss: V1ReplicaSet[];
			rs: V1ReplicaSet;
			expectedRSs: V1ReplicaSet[];
		}> = [
			{
				name: "expect to get back a ReplicaSet that is pending deletion",
				rss: [pendingDeletionRS, unrelatedRS],
				rs: pendingDeletionRS,
				expectedRSs: [pendingDeletionRS],
			},
			{
				name: "expect to get back only the given ReplicaSet if there is no related ReplicaSet",
				rss: [someRS, unrelatedRS],
				rs: someRS,
				expectedRSs: [someRS],
			},
			{
				name: "expect to get back the given ReplicaSet as well as any related ReplicaSet but not an unrelated ReplicaSet",
				rss: [someRS, relatedRS, unrelatedRS],
				rs: someRS,
				expectedRSs: [someRS, relatedRS],
			},
		];
		const manager = newTestReplicaSetController(ctx);
		for (const c of testCases) {
			for (const r of c.rss) {
				await manager.rsIndexer.add(r);
			}
			const actualRSs = manager.getReplicaSetsWithSameController(c.rs);
			const actualRSNames = actualRSs.map((r) => r.metadata?.name ?? "").sort();
			const expectedRSNames = c.expectedRSs.map((r) => r.metadata?.name ?? "").sort();
			expect({ name: c.name, actualRSNames }).toEqual({
				name: c.name,
				actualRSNames: expectedRSNames,
			});
		}
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestPodControllerLookup.
	it("TestPodControllerLookup", async () => {
		const manager = newTestReplicaSetController(ctx);
		const testCases: Array<{
			inRSs: V1ReplicaSet[];
			pod: V1Pod;
			outRSName: string;
		}> = [
			{
				inRSs: [
					{
						metadata: { name: "basic" },
					},
				],
				pod: { metadata: { name: "foo1", namespace: "" } },
				outRSName: "",
			},
			{
				inRSs: [
					{
						metadata: { name: "foo" },
						spec: { selector: { matchLabels: { foo: "bar" } } },
					},
				],
				pod: {
					metadata: { name: "foo2", namespace: "ns", labels: { foo: "bar" } },
				},
				outRSName: "",
			},
			{
				inRSs: [
					{
						metadata: { name: "bar", namespace: "ns" },
						spec: { selector: { matchLabels: { foo: "bar" } } },
					},
				],
				pod: {
					metadata: { name: "foo3", namespace: "ns", labels: { foo: "bar" } },
				},
				outRSName: "bar",
			},
		];
		for (const c of testCases) {
			for (const r of c.inRSs) {
				await manager.rsIndexer.add(r);
			}
			const rss = manager.getPodReplicaSets(c.pod);
			if (rss.length > 0) {
				if (rss.length !== 1) {
					expect(rss.length).toBe(1);
					continue;
				}
				const rs = rss[0];
				if (c.outRSName !== (rs.metadata?.name ?? "")) {
					expect(rs.metadata?.name ?? "").toBe(c.outRSName);
				}
			} else if (c.outRSName !== "") {
				expect.fail(
					`Expected a replica set ${c.outRSName} pod ${c.pod.metadata?.name ?? ""}, found none`,
				);
			}
		}
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestRelatedPodsLookup.
	it("TestRelatedPodsLookup", async () => {
		const someRS = newReplicaSet(1, { foo: "bar" });
		someRS.metadata!.name = "foo1";
		const relatedRS = newReplicaSet(1, { foo: "baz" });
		relatedRS.metadata!.name = "foo2";
		const unrelatedRS = newReplicaSet(1, { foo: "quux" });
		unrelatedRS.metadata!.name = "bar1";
		unrelatedRS.metadata!.ownerReferences![0].uid = "456";
		const pendingDeletionRS = newReplicaSet(1, { foo: "xyzzy" });
		pendingDeletionRS.metadata!.name = "foo3";
		pendingDeletionRS.metadata!.ownerReferences![0].uid = "789";
		const now = getClock(ctx).now();
		pendingDeletionRS.metadata!.deletionTimestamp = now;
		const pod1 = newPod("pod1", someRS, "Running", undefined, true);
		const pod2 = newPod("pod2", someRS, "Running", undefined, true);
		const pod3 = newPod("pod3", relatedRS, "Running", undefined, true);
		const pod4 = newPod("pod4", unrelatedRS, "Running", undefined, true);

		const testCases: Array<{
			name: string;
			rss: V1ReplicaSet[];
			pods: V1Pod[];
			rs: V1ReplicaSet;
			expectedPodNames: string[];
		}> = [
			{
				name: "expect to get a pod even if its owning ReplicaSet is pending deletion",
				rss: [pendingDeletionRS, unrelatedRS],
				rs: pendingDeletionRS,
				pods: [newPod("pod", pendingDeletionRS, "Running", undefined, true)],
				expectedPodNames: ["pod"],
			},
			{
				name: "expect to get only the ReplicaSet's own pods if there is no related ReplicaSet",
				rss: [someRS, unrelatedRS],
				rs: someRS,
				pods: [pod1, pod2, pod4],
				expectedPodNames: ["pod1", "pod2"],
			},
			{
				name: "expect to get own pods as well as any related ReplicaSet's but not an unrelated ReplicaSet's",
				rss: [someRS, relatedRS, unrelatedRS],
				rs: someRS,
				pods: [pod1, pod2, pod3, pod4],
				expectedPodNames: ["pod1", "pod2", "pod3"],
			},
		];
		for (const c of testCases) {
			const manager = newTestReplicaSetController(ctx);
			for (const r of c.rss) {
				await manager.rsIndexer.add(r);
			}
			for (const pod of c.pods) {
				await manager.podIndexer.add(pod);
				await manager.addPod(ctx, pod);
			}
			const [actualPods, err] = manager.getIndirectlyRelatedPods(c.rs);
			expect(err).toBeUndefined();
			const actualPodNames = actualPods.map((pod) => pod.metadata?.name ?? "").sort();
			c.expectedPodNames.sort();
			expect({ name: c.name, actualPodNames }).toEqual({
				name: c.name,
				actualPodNames: c.expectedPodNames,
			});
		}
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestUpdatePods.
	it("TestUpdatePods", async () => {
		const manager = newTestReplicaSetController(ctx);
		const received = new Channel<string>();

		manager.syncHandler = async (_ctx, key) => {
			const [namespace, name, keyErr] = splitMetaNamespaceKey(key);
			expect(keyErr).toBeUndefined();
			const [rsSpec, err] = manager.rsLister.replicaSets(namespace).get(name);
			expect(err).toBeUndefined();
			expect(rsSpec).toBeDefined();
			await received.send(rsSpec?.metadata?.name ?? "");
			return undefined;
		};

		const workerPromise = manager.worker(ctx);

		try {
			// Put 2 ReplicaSets and one pod into the informers
			const labelMap1 = { foo: "bar" };
			const testRSSpec1 = newReplicaSet(1, labelMap1);
			await addReplicaSet(manager, testRSSpec1);
			const testRSSpec2 = structuredClone(testRSSpec1);
			const labelMap2 = { bar: "foo" };
			testRSSpec2.spec = { ...(testRSSpec2.spec ?? {}), selector: { matchLabels: labelMap2 } };
			testRSSpec2.metadata = {
				...(testRSSpec2.metadata ?? {}),
				name: "barfoo",
			};
			await addReplicaSet(manager, testRSSpec2);

			const isController = true;
			const controllerRef1 = {
				uid: testRSSpec1.metadata?.uid ?? "",
				apiVersion: "v1",
				kind: "ReplicaSet",
				name: testRSSpec1.metadata?.name ?? "",
				controller: isController,
			};
			const controllerRef2 = {
				uid: testRSSpec2.metadata?.uid ?? "",
				apiVersion: "v1",
				kind: "ReplicaSet",
				name: testRSSpec2.metadata?.name ?? "",
				controller: isController,
			};

			// case 1: Pod with a ControllerRef
			let pod1 = firstPod(newPodList(1, "Running", labelMap1, testRSSpec1, "pod"));
			pod1.metadata = {
				...(pod1.metadata ?? {}),
				ownerReferences: [controllerRef1],
				resourceVersion: "1",
			};
			let pod2 = structuredClone(pod1);
			pod2.metadata = { ...(pod2.metadata ?? {}), labels: labelMap2, resourceVersion: "2" };
			await manager.updatePod(ctx, pod1, pod2);
			let expected = new Set([testRSSpec1.metadata?.name ?? ""]);
			for (const name of expected) {
				await select()
					.case(received, (got) => {
						expect(got.ok).toBe(true);
						expect(expected.has(got.value ?? "")).toBe(true);
					})
					.case(time.after(ctx, 10_000), () => {
						throw new Error(`Expected update notifications for replica set ${name}`);
					});
			}

			// case 2: Remove ControllerRef (orphan). Expect to sync label-matching RS.
			pod1 = firstPod(newPodList(1, "Running", labelMap1, testRSSpec1, "pod"));
			pod1.metadata = {
				...(pod1.metadata ?? {}),
				resourceVersion: "1",
				labels: labelMap2,
				ownerReferences: [controllerRef2],
			};
			pod2 = structuredClone(pod1);
			pod2.metadata = {
				...(pod2.metadata ?? {}),
				ownerReferences: undefined,
				resourceVersion: "2",
			};
			await manager.updatePod(ctx, pod1, pod2);
			expected = new Set([testRSSpec2.metadata?.name ?? ""]);
			for (const name of expected) {
				await select()
					.case(received, (got) => {
						expect(got.ok).toBe(true);
						expect(expected.has(got.value ?? "")).toBe(true);
					})
					.case(time.after(ctx, 10_000), () => {
						throw new Error(`Expected update notifications for replica set ${name}`);
					});
			}

			// case 2: Remove ControllerRef (orphan). Expect to sync both former owner and
			// any label-matching RS.
			pod1 = firstPod(newPodList(1, "Running", labelMap1, testRSSpec1, "pod"));
			pod1.metadata = {
				...(pod1.metadata ?? {}),
				resourceVersion: "1",
				labels: labelMap2,
				ownerReferences: [controllerRef1],
			};
			pod2 = structuredClone(pod1);
			pod2.metadata = {
				...(pod2.metadata ?? {}),
				ownerReferences: undefined,
				resourceVersion: "2",
			};
			await manager.updatePod(ctx, pod1, pod2);
			expected = new Set([testRSSpec1.metadata?.name ?? "", testRSSpec2.metadata?.name ?? ""]);
			for (const name of expected) {
				await select()
					.case(received, (got) => {
						expect(got.ok).toBe(true);
						expect(expected.has(got.value ?? "")).toBe(true);
					})
					.case(time.after(ctx, 10_000), () => {
						throw new Error(`Expected update notifications for replica set ${name}`);
					});
			}

			// case 4: Keep ControllerRef, change labels. Expect to sync owning RS.
			pod1 = firstPod(newPodList(1, "Running", labelMap1, testRSSpec1, "pod"));
			pod1.metadata = {
				...(pod1.metadata ?? {}),
				resourceVersion: "1",
				labels: labelMap1,
				ownerReferences: [controllerRef2],
			};
			pod2 = structuredClone(pod1);
			pod2.metadata = { ...(pod2.metadata ?? {}), labels: labelMap2, resourceVersion: "2" };
			await manager.updatePod(ctx, pod1, pod2);
			expected = new Set([testRSSpec2.metadata?.name ?? ""]);
			for (const name of expected) {
				await select()
					.case(received, (got) => {
						expect(got.ok).toBe(true);
						expect(expected.has(got.value ?? "")).toBe(true);
					})
					.case(time.after(ctx, 10_000), () => {
						throw new Error(`Expected update notifications for replica set ${name}`);
					});
			}
		} finally {
			await manager.queue.shutDown();
			await workerPromise;
		}
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestControllerUpdateRequeue.
	it("TestControllerUpdateRequeue", async () => {
		// This server should force a requeue of the controller because it fails to update status.Replicas.
		const labelMap = { foo: "bar" };
		const rs = newReplicaSet(1, labelMap);
		const fakePodControl = new FakePodControl();
		const [manager, client] = await newSeededTestReplicaSetController(ctx, [rs], fakePodControl);
		client.addReactor("update", "replicasets", (action) => {
			if (action.subresource !== "status") {
				return [false, undefined, undefined];
			}
			return [true, undefined, new Error("failed to update status")];
		});
		client.clearActions();

		await addReplicaSet(manager, rs);
		rs.status = { replicas: 2 };
		const pods = newPodList(1, "Running", labelMap, rs, "pod");
		await addPod(manager, firstPod(pods));

		// Enqueue once. Then process it. Disable rate-limiting for this.
		manager.queue = newTypedRateLimitingQueue(newTypedMaxOfRateLimiter<string>());
		manager.enqueueRS(rs);
		await manager.processNextWorkItem(ctx);

		// It should have been requeued.
		expect(manager.queue.len()).toBe(1);
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestControllerUpdateStatusWithFailure.
	it("TestControllerUpdateStatusWithFailure", async () => {
		const rs = newReplicaSet(1, { foo: "bar" });
		const [client] = await newTestKubeClient(ctx);
		client.addReactor("get", "replicasets", () => [true, rs, undefined]);
		client.addReactor("*", "*", () => [true, undefined, new Error("fake error")]);
		const numReplicas = 10;
		const newStatus = { replicas: numReplicas };
		const [, updateErr] = await updateReplicaSetStatus(
			client.appsv1,
			rs.metadata?.namespace ?? "default",
			rs.metadata?.name ?? "",
			rs,
			newStatus,
			defaultReplicaSetControllerFeatures(),
		);
		expect(updateErr?.message).toBe("fake error");

		let updates = 0;
		let gets = 0;
		for (const action of client.actions()) {
			if (action.resource !== "replicasets") {
				throw new Error(`Unexpected action ${JSON.stringify(action)}`);
			}

			switch (action.verb) {
				case "get": {
					gets++;
					const request = action.request;
					if (
						typeof request !== "object" ||
						request === null ||
						!("name" in request) ||
						request.name !== rs.metadata?.name
					) {
						throw new Error(
							`Expected get for ReplicaSet ${rs.metadata?.name}, got ${JSON.stringify(request)} instead`,
						);
					}
					break;
				}
				case "update": {
					updates++;
					const request = action.request;
					if (
						typeof request !== "object" ||
						request === null ||
						!("body" in request) ||
						typeof request.body !== "object" ||
						request.body === null ||
						!("status" in request.body) ||
						typeof request.body.status !== "object" ||
						request.body.status === null ||
						!("replicas" in request.body.status)
					) {
						throw new Error(
							`Expected a ReplicaSet as the argument to update, got ${JSON.stringify(request)}`,
						);
					}
					expect(request.body.status.replicas).toBe(numReplicas);
					break;
				}
				default:
					throw new Error(`Unexpected action ${JSON.stringify(action)}`);
			}
		}
		expect(gets).toBe(1);
		expect(updates).toBe(2);
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestDeleteControllerAndExpectations.
	it("TestDeleteControllerAndExpectations", async () => {
		const rs = newReplicaSet(1, { foo: "bar" });
		const fakePodControl = new FakePodControl();
		const [manager] = await newSeededTestReplicaSetController(ctx, [rs], fakePodControl);
		await addReplicaSet(manager, rs);

		const rsKey = getKey(rs);
		await manager.syncReplicaSet(ctx, rsKey);
		expect(validateSyncReplicaSet(fakePodControl, 1, 0, 0)).toBeUndefined();
		await fakePodControl.clear();

		const [podExp, exists, err] = manager.expectations.getExpectations(rsKey);
		expect(err).toBeUndefined();
		expect(exists).toBe(true);
		expect(podExp).toBeDefined();

		await manager.rsIndexer.delete(rs);
		await manager.deleteRS(ctx, rs);
		await manager.syncReplicaSet(ctx, rsKey);

		const [, existsAfterDelete, errAfterDelete] = manager.expectations.getExpectations(rsKey);
		expect(errAfterDelete).toBeUndefined();
		expect(existsAfterDelete).toBe(false);

		podExp!.add(-1, 0);
		await manager.podIndexer.replace([], "0");
		await manager.syncReplicaSet(ctx, rsKey);

		expect(validateSyncReplicaSet(fakePodControl, 0, 0, 0)).toBeUndefined();
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestOverlappingRSs.
	it("TestOverlappingRSs", async () => {
		const labelMap = { foo: "bar" };
		const manager = newTestReplicaSetController(ctx);
		const timestamp = new Date("2014-11-30T00:00:00.000Z");
		const controllers: V1ReplicaSet[] = [];
		for (let j = 1; j < 10; j++) {
			const rsSpec = newReplicaSet(1, labelMap);
			rsSpec.metadata = {
				...(rsSpec.metadata ?? {}),
				creationTimestamp: timestamp,
				name: `rs${j}`,
			};
			controllers.push(rsSpec);
		}
		const shuffledControllers = shuffle(controllers);
		for (let j = 0; j < shuffledControllers.length; j++) {
			await manager.rsIndexer.add(shuffledControllers[j]!);
		}

		const rs = controllers[3];
		if (!rs) {
			throw new Error("expected controller at index 3");
		}
		const pods = newPodList(1, "Pending", labelMap, rs, "pod");
		const pod = firstPod(pods);
		const isController = true;
		pod.metadata = {
			...(pod.metadata ?? {}),
			ownerReferences: [
				{
					uid: rs.metadata?.uid ?? "",
					apiVersion: "v1",
					kind: "ReplicaSet",
					name: rs.metadata?.name ?? "",
					controller: isController,
				},
			],
		};
		const rsKey = getKey(rs);

		await manager.addPod(ctx, pod);
		const [queueRS] = await manager.queue.get();

		expect(queueRS).toBe(rsKey);
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestDeletionTimestamp.
	it("TestDeletionTimestamp", async () => {
		const labelMap = { foo: "bar" };
		const rs = newReplicaSet(1, labelMap);
		const manager = newTestReplicaSetController(ctx);
		await addReplicaSet(manager, rs);
		const rsKey = getKey(rs);
		const pod = newPodList(1, "Pending", labelMap, rs, "pod")[0]!;
		pod.metadata = {
			...pod.metadata,
			deletionTimestamp: getClock(ctx).now(),
			resourceVersion: "1",
		};
		await manager.expectations.expectDeletions(rsKey, [podKey(pod)]);

		await manager.addPod(ctx, pod);

		let [indexedPod, podExists] = manager.podIndexer.getByKey(podKey(pod));
		expect(indexedPod).toBeDefined();
		expect(podExists).toBe(true);

		let [queueRS, done] = await manager.queue.get();
		expect(queueRS).toBe(rsKey);
		expect(done).toBe(false);
		manager.queue.done(rsKey);

		let [podExp, exists, err] = manager.expectations.getExpectations(rsKey);
		expect(err).toBeUndefined();
		expect(exists).toBe(true);
		expect(podExp?.fulfilled()).toBe(true);

		const oldPod = newPodList(1, "Pending", labelMap, rs, "pod")[0]!;
		oldPod.metadata = { ...oldPod.metadata, resourceVersion: "2" };
		await manager.expectations.expectDeletions(rsKey, [podKey(pod)]);
		await manager.updatePod(ctx, oldPod, pod);

		[indexedPod, podExists] = manager.podIndexer.getByKey(podKey(pod));
		expect(indexedPod).toBeDefined();
		expect(podExists).toBe(true);

		[queueRS, done] = await manager.queue.get();
		expect(queueRS).toBe(rsKey);
		expect(done).toBe(false);
		manager.queue.done(rsKey);

		[podExp, exists, err] = manager.expectations.getExpectations(rsKey);
		expect(err).toBeUndefined();
		expect(exists).toBe(true);
		expect(podExp?.fulfilled()).toBe(true);

		const isController = true;
		const secondPod: V1Pod = {
			metadata: {
				namespace: pod.metadata?.namespace,
				name: "secondPod",
				labels: pod.metadata?.labels,
				ownerReferences: [
					{
						uid: rs.metadata?.uid ?? "",
						apiVersion: "v1",
						kind: "ReplicaSet",
						name: rs.metadata?.name ?? "",
						controller: isController,
					},
				],
			},
		};
		await manager.expectations.expectDeletions(rsKey, [podKey(secondPod)]);
		oldPod.metadata = {
			...oldPod.metadata,
			deletionTimestamp: getClock(ctx).now(),
			resourceVersion: "2",
		};
		await manager.updatePod(ctx, oldPod, pod);

		[podExp, exists, err] = manager.expectations.getExpectations(rsKey);
		expect(err).toBeUndefined();
		expect(exists).toBe(true);
		expect(podExp?.fulfilled()).toBe(false);

		await manager.deletePod(ctx, pod);
		[podExp, exists, err] = manager.expectations.getExpectations(rsKey);
		expect(err).toBeUndefined();
		expect(exists).toBe(true);
		expect(podExp?.fulfilled()).toBe(false);

		await manager.deletePod(ctx, secondPod);

		[queueRS, done] = await manager.queue.get();
		expect(queueRS).toBe(rsKey);
		expect(done).toBe(false);
		manager.queue.done(rsKey);

		[podExp, exists, err] = manager.expectations.getExpectations(rsKey);
		expect(err).toBeUndefined();
		expect(exists).toBe(true);
		expect(podExp?.fulfilled()).toBe(true);
	});

	it("syncReplicaSet counts terminating pods still visible in the informer store", async () => {
		const labelMap = { foo: "bar" };
		const rs = newReplicaSet(1, labelMap);
		const fakePodControl = new FakePodControl();
		const [manager, client] = await newSeededTestReplicaSetController(ctx, [rs], fakePodControl);
		await addReplicaSet(manager, rs);

		const activePod = newPod("active-pod", rs, "Running", undefined, true);
		const terminatingPod = newPod("terminating-pod", rs, "Running", undefined, true);
		terminatingPod.metadata = {
			...terminatingPod.metadata,
			deletionTimestamp: getClock(ctx).now(),
			resourceVersion: "1",
		};
		await addPod(manager, activePod);
		await manager.addPod(ctx, terminatingPod);
		client.clearActions();

		await expect(manager.syncReplicaSet(ctx, getKey(rs))).resolves.toBeUndefined();

		const updatedRS = await client.appsv1.readNamespacedReplicaSet({
			namespace: rs.metadata?.namespace ?? "default",
			name: rs.metadata?.name ?? "",
		});
		expect(updatedRS.status?.replicas).toBe(1);
		expect(updatedRS.status?.terminatingReplicas).toBe(1);
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestDoNotPatchPodWithOtherControlRef.
	it("TestDoNotPatchPodWithOtherControlRef", async () => {
		const labelMap = { foo: "bar" };
		const rs = newReplicaSet(2, labelMap);
		const fakePodControl = new FakePodControl();
		const [manager, client] = await newSeededTestReplicaSetController(ctx, [rs], fakePodControl);
		await addReplicaSet(manager, rs);
		const trueVar = true;
		const otherControllerReference = {
			uid: "another-rs",
			apiVersion: "v1beta1",
			kind: "ReplicaSet",
			name: "AnotherRS",
			controller: trueVar,
		};
		// Add to podLister a matching Pod controlled by another controller. Expect no patch.
		const pod = newPod("pod", rs, "Running", undefined, true);
		pod.metadata = {
			...pod.metadata,
			ownerReferences: [otherControllerReference],
		};
		await addPod(manager, pod);
		client.clearActions();

		await manager.syncReplicaSet(ctx, getKey(rs));

		expect(validateSyncReplicaSet(fakePodControl, 2, 0, 0)).toBeUndefined();
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestDoNotAdoptOrCreateIfBeingDeleted.
	it("TestDoNotAdoptOrCreateIfBeingDeleted", async () => {
		const labelMap = { foo: "bar" };
		const rs = newReplicaSet(2, labelMap);
		const now = getClock(ctx).now();
		rs.metadata = { ...rs.metadata, deletionTimestamp: now };
		const fakePodControl = new FakePodControl();
		const [manager] = await newSeededTestReplicaSetController(ctx, [rs], fakePodControl);
		await addReplicaSet(manager, rs);
		const pod1 = newPod("pod1", rs, "Running", undefined, false);
		await addPod(manager, pod1);

		const err = await manager.syncReplicaSet(ctx, getKey(rs));
		expect(err).toBeUndefined();
		expect(validateSyncReplicaSet(fakePodControl, 0, 0, 0)).toBeUndefined();
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestReplicaSetAvailabilityCheck.
	it("TestReplicaSetAvailabilityCheck", async () => {
		const labelMap = { foo: "bar" };
		const rs = newReplicaSet(4, labelMap);
		rs.spec!.minReadySeconds = 5;
		const fakePodControl = new FakePodControl();
		const [manager, client] = await newSeededTestReplicaSetController(ctx, [rs], fakePodControl);
		await addReplicaSet(manager, rs);

		const now = getClock(ctx).now();
		const pod1 = newPod("foobar-1", rs, "Pending", undefined, true);
		const pod2 = newPod("foobar-2", rs, "Running", now, true);
		const pod3 = newPod("foobar-3", rs, "Running", new Date(now.getTime() - 2_000), true);
		const pod4 = newPod("foobar-4", rs, "Running", new Date(now.getTime() - 4_300), true);
		await addPod(manager, pod1);
		await addPod(manager, pod2);
		await addPod(manager, pod3);
		await addPod(manager, pod4);
		client.clearActions();

		const err = await manager.syncReplicaSet(ctx, getKey(rs));
		expect(err).toBeUndefined();

		let updatedRs: V1ReplicaSet | undefined;
		for (const action of client.actions()) {
			if (action.resource !== "replicasets") {
				throw new Error(`Unexpected action ${JSON.stringify(action)}`);
			}

			if (action.verb !== "update") {
				throw new Error(`Unexpected action ${JSON.stringify(action)}`);
			}

			const request = action.request;
			if (
				typeof request !== "object" ||
				request === null ||
				!("body" in request) ||
				typeof request.body !== "object" ||
				request.body === null
			) {
				throw new Error(
					`Expected a ReplicaSet as the argument to update, got ${JSON.stringify(request)}`,
				);
			}
			updatedRs = request.body as V1ReplicaSet;
		}

		expect(updatedRs?.status?.readyReplicas).toBe(3);
		expect(updatedRs?.status?.availableReplicas).toBe(0);

		expect(manager.queue.len()).toBe(0);
		for (let i = 0; i < 10; i++) {
			await Promise.resolve();
		}
		getClock(ctx).step(900);
		for (let i = 0; i < 10; i++) {
			await Promise.resolve();
		}
		expect(manager.queue.len()).toBe(1);
	});

	// Local regression coverage for the invalid-selector branch in upstream
	// syncReplicaSet. Upstream returns nil there, but replica_set_test.go does
	// not have a dedicated test for it.
	it("TestSyncReplicaSetInvalidSelectorDoesNotRequeue", async () => {
		const rs = newReplicaSet(1, { foo: "bar" });
		rs.spec!.selector = {
			matchExpressions: [{ key: "foo", operator: "Invalid" }],
		};
		const fakePodControl = new FakePodControl();
		const [client, kubeConfig] = await newTestKubeClient(ctx);
		const manager = new ReplicaSetController(
			client,
			kubeConfig,
			defaultReplicaSetControllerFeatures(),
			undefined,
			fakePodControl,
		);
		await addReplicaSet(manager, rs);
		client.clearActions();

		await expect(manager.syncReplicaSet(ctx, getKey(rs))).resolves.toBeUndefined();

		expect(validateSyncReplicaSet(fakePodControl, 0, 0, 0)).toBeUndefined();
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_utils_test.go TestCalculateStatus.
	it("TestCalculateStatus", () => {
		const labelMap = { name: "foo" };
		const fullLabelMap = { name: "foo", type: "production" };
		const notFullyLabelledRS = newReplicaSet(1, labelMap);
		const fullyLabelledRS = newReplicaSet(2, fullLabelMap);
		const longMinReadySeconds = 3600;
		const longMinReadySecondsRS = newReplicaSet(1, fullLabelMap);
		longMinReadySecondsRS.spec!.minReadySeconds = longMinReadySeconds;

		// Models kubernetes/pkg/controller/replicaset/replica_set_utils_test.go TestCalculateStatus asTerminating.
		const asTerminating = (pod: V1Pod): V1Pod => {
			pod.metadata ??= {};
			pod.metadata.deletionTimestamp = now;
			return pod;
		};

		const clock = getClock(ctx);
		const now = clock.now();

		const rsStatusTests: Array<{
			name: string;
			enableDeploymentReplicaSetTerminatingReplicas: boolean;
			replicaset: V1ReplicaSet;
			activePods: V1Pod[];
			terminatingPods?: V1Pod[];
			controllerFeatures?: ReplicaSetControllerFeatures;
			expectedReplicaSetStatus: V1ReplicaSetStatus;
		}> = [
			{
				name: "1 fully labelled pod",
				enableDeploymentReplicaSetTerminatingReplicas: false,
				replicaset: fullyLabelledRS,
				activePods: [newPod("pod1", fullyLabelledRS, "Running", undefined, true)],
				terminatingPods: undefined,
				controllerFeatures: undefined,
				expectedReplicaSetStatus: {
					replicas: 1,
					fullyLabeledReplicas: 1,
					readyReplicas: 1,
					availableReplicas: 1,
					terminatingReplicas: undefined,
				},
			},
			{
				name: "1 not fully labelled pod",
				enableDeploymentReplicaSetTerminatingReplicas: false,
				replicaset: notFullyLabelledRS,
				activePods: [newPod("pod1", notFullyLabelledRS, "Running", undefined, true)],
				terminatingPods: undefined,
				controllerFeatures: undefined,
				expectedReplicaSetStatus: {
					replicas: 1,
					fullyLabeledReplicas: 0,
					readyReplicas: 1,
					availableReplicas: 1,
					terminatingReplicas: undefined,
				},
			},
			{
				name: "2 fully labelled pods",
				enableDeploymentReplicaSetTerminatingReplicas: false,
				replicaset: fullyLabelledRS,
				activePods: [
					newPod("pod1", fullyLabelledRS, "Running", undefined, true),
					newPod("pod2", fullyLabelledRS, "Running", undefined, true),
				],
				terminatingPods: undefined,
				controllerFeatures: undefined,
				expectedReplicaSetStatus: {
					replicas: 2,
					fullyLabeledReplicas: 2,
					readyReplicas: 2,
					availableReplicas: 2,
					terminatingReplicas: undefined,
				},
			},
			{
				name: "2 fully labelled pods with DeploymentReplicaSetTerminatingReplicas",
				enableDeploymentReplicaSetTerminatingReplicas: true,
				replicaset: fullyLabelledRS,
				activePods: [
					newPod("pod1", fullyLabelledRS, "Running", undefined, true),
					newPod("pod2", fullyLabelledRS, "Running", undefined, true),
				],
				terminatingPods: undefined,
				controllerFeatures: undefined,
				expectedReplicaSetStatus: {
					replicas: 2,
					fullyLabeledReplicas: 2,
					readyReplicas: 2,
					availableReplicas: 2,
					terminatingReplicas: 0,
				},
			},
			{
				name: "2 not fully labelled pods",
				enableDeploymentReplicaSetTerminatingReplicas: false,
				replicaset: notFullyLabelledRS,
				activePods: [
					newPod("pod1", notFullyLabelledRS, "Running", undefined, true),
					newPod("pod2", notFullyLabelledRS, "Running", undefined, true),
				],
				terminatingPods: undefined,
				controllerFeatures: undefined,
				expectedReplicaSetStatus: {
					replicas: 2,
					fullyLabeledReplicas: 0,
					readyReplicas: 2,
					availableReplicas: 2,
					terminatingReplicas: undefined,
				},
			},
			{
				name: "1 fully labelled pod, 1 not fully labelled pod",
				enableDeploymentReplicaSetTerminatingReplicas: false,
				replicaset: notFullyLabelledRS,
				activePods: [
					newPod("pod1", notFullyLabelledRS, "Running", undefined, true),
					newPod("pod2", fullyLabelledRS, "Running", undefined, true),
				],
				terminatingPods: undefined,
				controllerFeatures: undefined,
				expectedReplicaSetStatus: {
					replicas: 2,
					fullyLabeledReplicas: 1,
					readyReplicas: 2,
					availableReplicas: 2,
					terminatingReplicas: undefined,
				},
			},
			{
				name: "1 non-ready pod",
				enableDeploymentReplicaSetTerminatingReplicas: false,
				replicaset: fullyLabelledRS,
				activePods: [newPod("pod1", fullyLabelledRS, "Pending", undefined, true)],
				terminatingPods: undefined,
				controllerFeatures: undefined,
				expectedReplicaSetStatus: {
					replicas: 1,
					fullyLabeledReplicas: 1,
					readyReplicas: 0,
					availableReplicas: 0,
					terminatingReplicas: undefined,
				},
			},
			{
				name: "1 ready but non-available pod",
				enableDeploymentReplicaSetTerminatingReplicas: false,
				replicaset: longMinReadySecondsRS,
				activePods: [newPod("pod1", longMinReadySecondsRS, "Running", now, true)],
				terminatingPods: undefined,
				controllerFeatures: undefined,
				expectedReplicaSetStatus: {
					replicas: 1,
					fullyLabeledReplicas: 1,
					readyReplicas: 1,
					availableReplicas: 0,
					terminatingReplicas: undefined,
				},
			},
			{
				name: "1 available pod with minReadySeconds",
				enableDeploymentReplicaSetTerminatingReplicas: false,
				replicaset: longMinReadySecondsRS,
				activePods: [
					newPod(
						"pod1",
						longMinReadySecondsRS,
						"Running",
						new Date(now.getTime() - longMinReadySeconds * 1000),
						true,
					),
				],
				terminatingPods: undefined,
				controllerFeatures: undefined,
				expectedReplicaSetStatus: {
					replicas: 1,
					fullyLabeledReplicas: 1,
					readyReplicas: 1,
					availableReplicas: 1,
					terminatingReplicas: undefined,
				},
			},
			{
				name: "1 available pod for a long time with minReadySeconds",
				enableDeploymentReplicaSetTerminatingReplicas: false,
				replicaset: longMinReadySecondsRS,
				activePods: [
					newPod(
						"pod1",
						longMinReadySecondsRS,
						"Running",
						new Date(now.getTime() - 2 * longMinReadySeconds * 1000),
						true,
					),
				],
				terminatingPods: undefined,
				controllerFeatures: undefined,
				expectedReplicaSetStatus: {
					replicas: 1,
					fullyLabeledReplicas: 1,
					readyReplicas: 1,
					availableReplicas: 1,
					terminatingReplicas: undefined,
				},
			},
			{
				name: "1 fully labelled pod and 1 terminating without DeploymentReplicaSetTerminatingReplicas",
				enableDeploymentReplicaSetTerminatingReplicas: false,
				replicaset: fullyLabelledRS,
				activePods: [newPod("pod1", fullyLabelledRS, "Running", undefined, true)],
				terminatingPods: [
					asTerminating(newPod("pod2", fullyLabelledRS, "Running", undefined, true)),
				],
				controllerFeatures: undefined,
				expectedReplicaSetStatus: {
					replicas: 1,
					fullyLabeledReplicas: 1,
					readyReplicas: 1,
					availableReplicas: 1,
					terminatingReplicas: undefined,
				},
			},
			{
				name: "1 fully labelled pods and 2 terminating with DeploymentReplicaSetTerminatingReplicas",
				enableDeploymentReplicaSetTerminatingReplicas: true,
				replicaset: fullyLabelledRS,
				activePods: [newPod("pod1", fullyLabelledRS, "Running", undefined, true)],
				terminatingPods: [
					asTerminating(newPod("pod2", fullyLabelledRS, "Running", undefined, true)),
					asTerminating(newPod("pod3", fullyLabelledRS, "Running", undefined, true)),
				],
				controllerFeatures: undefined,
				expectedReplicaSetStatus: {
					replicas: 1,
					fullyLabeledReplicas: 1,
					readyReplicas: 1,
					availableReplicas: 1,
					terminatingReplicas: 2,
				},
			},
			{
				name: "1 fully labelled pods and 2 terminating with DeploymentReplicaSetTerminatingReplicas (ReplicationController)",
				enableDeploymentReplicaSetTerminatingReplicas: true,
				replicaset: fullyLabelledRS,
				activePods: [newPod("pod1", fullyLabelledRS, "Running", undefined, true)],
				terminatingPods: [
					asTerminating(newPod("pod2", fullyLabelledRS, "Running", undefined, true)),
					asTerminating(newPod("pod3", fullyLabelledRS, "Running", undefined, true)),
				],
				controllerFeatures: {
					enableStatusTerminatingReplicas: false,
				},
				expectedReplicaSetStatus: {
					replicas: 1,
					fullyLabeledReplicas: 1,
					readyReplicas: 1,
					availableReplicas: 1,
					terminatingReplicas: undefined,
				},
			},
		];

		for (const test of rsStatusTests) {
			const controllerFeatures = test.controllerFeatures ?? defaultReplicaSetControllerFeatures();
			const replicaSetStatus = calculateStatus(
				test.replicaset,
				test.activePods,
				test.terminatingPods ?? [],
				undefined,
				{
					...controllerFeatures,
					enableStatusTerminatingReplicas:
						test.enableDeploymentReplicaSetTerminatingReplicas &&
						controllerFeatures.enableStatusTerminatingReplicas,
				},
				now,
			);
			expect({ name: test.name, replicaSetStatus }).toEqual({
				name: test.name,
				replicaSetStatus: test.expectedReplicaSetStatus,
			});
		}
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_utils_test.go TestCalculateStatusConditions.
	it("TestCalculateStatusConditions", () => {
		const labelMap = { name: "foo" };
		const rs = newReplicaSet(2, labelMap);
		const replicaFailureRS = newReplicaSet(10, labelMap);
		replicaFailureRS.status!.conditions = [
			{
				type: "ReplicaFailure",
				status: "True",
			},
		];

		const rsStatusConditionTests: Array<{
			name: string;
			replicaset: V1ReplicaSet;
			activePods: V1Pod[];
			manageReplicasErr?: Error;
			expectedReplicaSetConditions?: V1ReplicaSetCondition[];
		}> = [
			{
				name: "manageReplicasErr != nil && failureCond == nil, diff < 0",
				replicaset: rs,
				activePods: [newPod("pod1", rs, "Running", undefined, true)],
				manageReplicasErr: new Error("fake manageReplicasErr"),
				expectedReplicaSetConditions: [
					{
						type: "ReplicaFailure",
						status: "True",
						reason: "FailedCreate",
						message: "fake manageReplicasErr",
					},
				],
			},
			{
				name: "manageReplicasErr != nil && failureCond == nil, diff > 0",
				replicaset: rs,
				activePods: [
					newPod("pod1", rs, "Running", undefined, true),
					newPod("pod2", rs, "Running", undefined, true),
					newPod("pod3", rs, "Running", undefined, true),
				],
				manageReplicasErr: new Error("fake manageReplicasErr"),
				expectedReplicaSetConditions: [
					{
						type: "ReplicaFailure",
						status: "True",
						reason: "FailedDelete",
						message: "fake manageReplicasErr",
					},
				],
			},
			{
				name: "manageReplicasErr == nil && failureCond != nil",
				replicaset: replicaFailureRS,
				activePods: [newPod("pod1", replicaFailureRS, "Running", undefined, true)],
				manageReplicasErr: undefined,
				expectedReplicaSetConditions: undefined,
			},
			{
				name: "manageReplicasErr != nil && failureCond != nil",
				replicaset: replicaFailureRS,
				activePods: [newPod("pod1", replicaFailureRS, "Running", undefined, true)],
				manageReplicasErr: new Error("fake manageReplicasErr"),
				expectedReplicaSetConditions: [
					{
						type: "ReplicaFailure",
						status: "True",
					},
				],
			},
			{
				name: "manageReplicasErr == nil && failureCond == nil",
				replicaset: rs,
				activePods: [newPod("pod1", rs, "Running", undefined, true)],
				manageReplicasErr: undefined,
				expectedReplicaSetConditions: undefined,
			},
		];

		for (const test of rsStatusConditionTests) {
			const replicaSetStatus = calculateStatus(
				test.replicaset,
				test.activePods,
				[],
				test.manageReplicasErr,
				defaultReplicaSetControllerFeatures(),
				new Date(),
			);
			if ((replicaSetStatus.conditions ?? []).length > 0) {
				test.expectedReplicaSetConditions![0].lastTransitionTime =
					replicaSetStatus.conditions![0].lastTransitionTime;
			}
			expect({ name: test.name, conditions: replicaSetStatus.conditions }).toEqual({
				name: test.name,
				conditions: test.expectedReplicaSetConditions,
			});
		}
	});

	it("updateReplicaSetStatus treats nil and zero terminatingReplicas as different", async () => {
		const rs = newReplicaSet(0, { foo: "bar" });
		rs.metadata = {
			...rs.metadata,
			generation: 1,
		};
		rs.status = {
			replicas: 0,
			fullyLabeledReplicas: 0,
			readyReplicas: 0,
			availableReplicas: 0,
			observedGeneration: 1,
			terminatingReplicas: undefined,
		};
		const [, client] = await newSeededTestReplicaSetController(ctx, [rs]);
		client.clearActions();

		const [updatedRS, err] = await updateReplicaSetStatus(
			client.appsv1,
			rs.metadata?.namespace ?? "default",
			rs.metadata?.name ?? "",
			rs,
			{
				replicas: 0,
				fullyLabeledReplicas: 0,
				readyReplicas: 0,
				availableReplicas: 0,
				terminatingReplicas: 0,
			},
			defaultReplicaSetControllerFeatures(),
		);

		expect(err).toBeUndefined();
		expect(updatedRS?.status?.terminatingReplicas).toBe(0);
		expect(
			client
				.actions()
				.filter(
					(action) =>
						action.verb === "update" &&
						action.resource === "replicasets" &&
						action.subresource === "status",
				),
		).toHaveLength(1);
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go imagePullBackOff.
	const imagePullBackOff = "ImagePullBackOff";

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go condImagePullBackOff.
	const condImagePullBackOff = (): V1ReplicaSetCondition => ({
		type: imagePullBackOff,
		status: "True",
		reason: "NonExistentImage",
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go condReplicaFailure.
	const condReplicaFailure = (): V1ReplicaSetCondition => ({
		type: "ReplicaFailure",
		status: "True",
		reason: "OtherFailure",
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go condReplicaFailure2.
	const condReplicaFailure2 = (): V1ReplicaSetCondition => ({
		type: "ReplicaFailure",
		status: "True",
		reason: "AnotherFailure",
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go status.
	const status = (): V1ReplicaSetStatus => ({
		replicas: 0,
		conditions: [condReplicaFailure()],
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestGetCondition.
	it("TestGetCondition", () => {
		const exampleStatus = status();

		const tests: Array<{
			name: string;
			status: V1ReplicaSetStatus;
			condType: string;
			expected: boolean;
		}> = [
			{
				name: "condition exists",
				status: { ...exampleStatus },
				condType: "ReplicaFailure",
				expected: true,
			},
			{
				name: "condition does not exist",
				status: { ...exampleStatus },
				condType: imagePullBackOff,
				expected: false,
			},
		];

		for (const test of tests) {
			const cond = getCondition(test.status, test.condType);
			const exists = cond !== undefined;
			expect({ name: test.name, exists }).toEqual({
				name: test.name,
				exists: test.expected,
			});
		}
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestSetCondition.
	it("TestSetCondition", () => {
		const tests: Array<{
			name: string;
			status: V1ReplicaSetStatus;
			cond: V1ReplicaSetCondition;
			expectedStatus: V1ReplicaSetStatus;
		}> = [
			{
				name: "set for the first time",
				status: { replicas: 0 },
				cond: condReplicaFailure(),
				expectedStatus: { replicas: 0, conditions: [condReplicaFailure()] },
			},
			{
				name: "simple set",
				status: { replicas: 0, conditions: [condImagePullBackOff()] },
				cond: condReplicaFailure(),
				expectedStatus: {
					replicas: 0,
					conditions: [condImagePullBackOff(), condReplicaFailure()],
				},
			},
			{
				name: "overwrite",
				status: { replicas: 0, conditions: [condReplicaFailure()] },
				cond: condReplicaFailure2(),
				expectedStatus: { replicas: 0, conditions: [condReplicaFailure2()] },
			},
		];

		for (const test of tests) {
			setCondition(test.status, test.cond);
			expect({ name: test.name, status: test.status }).toEqual({
				name: test.name,
				status: test.expectedStatus,
			});
		}
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestRemoveCondition.
	it("TestRemoveCondition", () => {
		const tests: Array<{
			name: string;
			status: V1ReplicaSetStatus;
			condType: string;
			expectedStatus: V1ReplicaSetStatus;
		}> = [
			{
				name: "remove from empty status",
				status: { replicas: 0 },
				condType: "ReplicaFailure",
				expectedStatus: { replicas: 0 },
			},
			{
				name: "simple remove",
				status: { replicas: 0, conditions: [condReplicaFailure()] },
				condType: "ReplicaFailure",
				expectedStatus: { replicas: 0 },
			},
			{
				name: "doesn't remove anything",
				status: status(),
				condType: imagePullBackOff,
				expectedStatus: status(),
			},
		];

		for (const test of tests) {
			removeCondition(test.status, test.condType);
			expect({ name: test.name, status: test.status }).toEqual({
				name: test.name,
				status: test.expectedStatus,
			});
		}
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestSlowStartBatch.
	it("TestSlowStartBatch", async () => {
		const fakeErr = new Error("fake error");
		let callCnt = 0;
		let callLimit = 0;
		const lock = new Mutex();
		const fn = async (): Promise<Error | undefined> => {
			return await lock.withLock(() => {
				callCnt++;
				if (callCnt > callLimit) {
					return fakeErr;
				}
				return undefined;
			});
		};

		const tests: Array<{
			name: string;
			count: number;
			callLimit: number;
			fn: () => Promise<Error | undefined>;
			expectedSuccesses: number;
			expectedErr: Error | undefined;
			expectedCallCnt: number;
		}> = [
			{
				name: "callLimit = 0 (all fail)",
				count: 10,
				callLimit: 0,
				fn,
				expectedSuccesses: 0,
				expectedErr: fakeErr,
				expectedCallCnt: 1,
			},
			{
				name: "callLimit = count (all succeed)",
				count: 10,
				callLimit: 10,
				fn,
				expectedSuccesses: 10,
				expectedErr: undefined,
				expectedCallCnt: 10,
			},
			{
				name: "callLimit < count (some succeed)",
				count: 10,
				callLimit: 5,
				fn,
				expectedSuccesses: 5,
				expectedErr: fakeErr,
				expectedCallCnt: 7,
			},
		];

		for (const test of tests) {
			callCnt = 0;
			callLimit = test.callLimit;
			const [successes, err] = await slowStartBatch(test.count, 1, test.fn);
			expect({ name: test.name, successes }).toEqual({
				name: test.name,
				successes: test.expectedSuccesses,
			});
			expect({ name: test.name, err }).toEqual({ name: test.name, err: test.expectedErr });
			expect({ name: test.name, callCnt }).toEqual({
				name: test.name,
				callCnt: test.expectedCallCnt,
			});
		}
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestGetPodsToDelete.
	it("TestGetPodsToDelete", () => {
		const labelMap = { name: "foo" };
		const rs = newReplicaSet(1, labelMap);
		const unscheduledPendingPod = newPod("unscheduled-pending-pod", rs, "Pending", undefined, true);
		const scheduledPendingPod = newPod("scheduled-pending-pod", rs, "Pending", undefined, true);
		scheduledPendingPod.spec = { containers: [] };
		scheduledPendingPod.spec!.nodeName = "fake-node";
		const scheduledRunningNotReadyPod = newPod(
			"scheduled-running-not-ready-pod",
			rs,
			"Running",
			undefined,
			true,
		);
		scheduledRunningNotReadyPod.spec = { containers: [] };
		scheduledRunningNotReadyPod.spec!.nodeName = "fake-node";
		scheduledRunningNotReadyPod.status!.conditions = [{ type: "Ready", status: "False" }];
		const scheduledRunningReadyPodOnNode1 = newPod(
			"scheduled-running-ready-pod-on-node-1",
			rs,
			"Running",
			undefined,
			true,
		);
		scheduledRunningReadyPodOnNode1.spec = { containers: [] };
		scheduledRunningReadyPodOnNode1.spec!.nodeName = "fake-node-1";
		scheduledRunningReadyPodOnNode1.status!.conditions = [{ type: "Ready", status: "True" }];
		const scheduledRunningReadyPodOnNode2 = newPod(
			"scheduled-running-ready-pod-on-node-2",
			rs,
			"Running",
			undefined,
			true,
		);
		scheduledRunningReadyPodOnNode2.spec = { containers: [] };
		scheduledRunningReadyPodOnNode2.spec!.nodeName = "fake-node-2";
		scheduledRunningReadyPodOnNode2.status!.conditions = [{ type: "Ready", status: "True" }];
		const now = getClock(ctx).now();
		const newerReadyPodWithLaterUID = newPod(
			"newer-ready-pod-with-later-uid",
			rs,
			"Running",
			undefined,
			true,
		);
		newerReadyPodWithLaterUID.metadata = {
			...newerReadyPodWithLaterUID.metadata,
			uid: "z",
			creationTimestamp: new Date(now.getTime() - 10_000),
		};
		newerReadyPodWithLaterUID.spec = { containers: [], nodeName: "fake-node" };
		newerReadyPodWithLaterUID.status = {
			phase: "Running",
			conditions: [
				{
					type: "Ready",
					status: "True",
					lastTransitionTime: new Date(now.getTime() - 100),
				},
			],
		};
		const olderReadyPodWithEarlierUID = newPod(
			"older-ready-pod-with-earlier-uid",
			rs,
			"Running",
			undefined,
			true,
		);
		olderReadyPodWithEarlierUID.metadata = {
			...olderReadyPodWithEarlierUID.metadata,
			uid: "a",
			creationTimestamp: new Date(now.getTime() - 10_000),
		};
		olderReadyPodWithEarlierUID.spec = { containers: [], nodeName: "fake-node" };
		olderReadyPodWithEarlierUID.status = {
			phase: "Running",
			conditions: [
				{
					type: "Ready",
					status: "True",
					lastTransitionTime: new Date(now.getTime() - 120),
				},
			],
		};

		const tests: Array<{
			name: string;
			pods: V1Pod[];
			related?: V1Pod[];
			diff: number;
			expectedPodsToDelete: V1Pod[];
		}> = [
			{
				name: "len(pods) = 0 (i.e., diff = 0 too)",
				pods: [],
				diff: 0,
				expectedPodsToDelete: [],
			},
			{
				name: "diff = len(pods)",
				pods: [scheduledRunningNotReadyPod, scheduledRunningReadyPodOnNode1],
				diff: 2,
				expectedPodsToDelete: [scheduledRunningNotReadyPod, scheduledRunningReadyPodOnNode1],
			},
			{
				name: "diff < len(pods)",
				pods: [scheduledRunningReadyPodOnNode1, scheduledRunningNotReadyPod],
				diff: 1,
				expectedPodsToDelete: [scheduledRunningNotReadyPod],
			},
			{
				name: "various pod phases and conditions, diff = len(pods)",
				pods: [
					scheduledRunningReadyPodOnNode1,
					scheduledRunningReadyPodOnNode1,
					scheduledRunningReadyPodOnNode2,
					scheduledRunningNotReadyPod,
					scheduledPendingPod,
					unscheduledPendingPod,
				],
				diff: 6,
				expectedPodsToDelete: [
					scheduledRunningReadyPodOnNode1,
					scheduledRunningReadyPodOnNode1,
					scheduledRunningReadyPodOnNode2,
					scheduledRunningNotReadyPod,
					scheduledPendingPod,
					unscheduledPendingPod,
				],
			},
			{
				name: "various pod phases and conditions, diff = len(pods), relatedPods empty",
				pods: [
					scheduledRunningReadyPodOnNode1,
					scheduledRunningReadyPodOnNode1,
					scheduledRunningReadyPodOnNode2,
					scheduledRunningNotReadyPod,
					scheduledPendingPod,
					unscheduledPendingPod,
				],
				related: [],
				diff: 6,
				expectedPodsToDelete: [
					scheduledRunningReadyPodOnNode1,
					scheduledRunningReadyPodOnNode1,
					scheduledRunningReadyPodOnNode2,
					scheduledRunningNotReadyPod,
					scheduledPendingPod,
					unscheduledPendingPod,
				],
			},
			{
				name: "scheduled vs unscheduled, diff < len(pods)",
				pods: [scheduledPendingPod, unscheduledPendingPod],
				diff: 1,
				expectedPodsToDelete: [unscheduledPendingPod],
			},
			{
				name: "ready vs not-ready, diff < len(pods)",
				pods: [
					scheduledRunningReadyPodOnNode1,
					scheduledRunningNotReadyPod,
					scheduledRunningNotReadyPod,
				],
				diff: 2,
				expectedPodsToDelete: [scheduledRunningNotReadyPod, scheduledRunningNotReadyPod],
			},
			{
				name: "ready and colocated with another ready pod vs not colocated, diff < len(pods)",
				pods: [scheduledRunningReadyPodOnNode1, scheduledRunningReadyPodOnNode2],
				related: [
					scheduledRunningReadyPodOnNode1,
					scheduledRunningReadyPodOnNode2,
					scheduledRunningReadyPodOnNode2,
				],
				diff: 1,
				expectedPodsToDelete: [scheduledRunningReadyPodOnNode2],
			},
			{
				name: "pending vs running, diff < len(pods)",
				pods: [scheduledPendingPod, scheduledRunningNotReadyPod],
				diff: 1,
				expectedPodsToDelete: [scheduledPendingPod],
			},
			{
				name: "various pod phases and conditions, diff < len(pods)",
				pods: [
					scheduledRunningReadyPodOnNode1,
					scheduledRunningReadyPodOnNode2,
					scheduledRunningNotReadyPod,
					scheduledPendingPod,
					unscheduledPendingPod,
				],
				diff: 3,
				expectedPodsToDelete: [
					unscheduledPendingPod,
					scheduledPendingPod,
					scheduledRunningNotReadyPod,
				],
			},
			{
				name: "ready time logarithmic tie sorts by UID, diff < len(pods)",
				pods: [newerReadyPodWithLaterUID, olderReadyPodWithEarlierUID],
				diff: 1,
				expectedPodsToDelete: [olderReadyPodWithEarlierUID],
			},
		];

		for (const test of tests) {
			const related = test.related ?? test.pods;
			const podsToDelete = getPodsToDelete(test.pods, related, test.diff, now);
			expect({ name: test.name, len: podsToDelete.length }).toEqual({
				name: test.name,
				len: test.expectedPodsToDelete.length,
			});
			expect({ name: test.name, podsToDelete }).toEqual({
				name: test.name,
				podsToDelete: test.expectedPodsToDelete,
			});
		}
	});

	// Models kubernetes/pkg/controller/replicaset/replica_set_test.go TestGetPodKeys.
	it("TestGetPodKeys", () => {
		const labelMap = { name: "foo" };
		const rs = newReplicaSet(1, labelMap);
		const pod1 = newPod("pod1", rs, "Running", undefined, true);
		const pod2 = newPod("pod2", rs, "Running", undefined, true);

		const tests: Array<{
			name: string;
			pods: V1Pod[];
			expectedPodKeys: string[];
		}> = [
			{
				name: "len(pods) = 0 (i.e., pods = nil)",
				pods: [],
				expectedPodKeys: [],
			},
			{
				name: "len(pods) > 0",
				pods: [pod1, pod2],
				expectedPodKeys: ["default/pod1", "default/pod2"],
			},
		];

		for (const test of tests) {
			const podKeys = getPodKeys(test.pods);
			expect({ name: test.name, len: podKeys.length }).toEqual({
				name: test.name,
				len: test.expectedPodKeys.length,
			});
			for (let i = 0; i < podKeys.length; i++) {
				expect({ name: test.name, key: podKeys[i] }).toEqual({
					name: test.name,
					key: test.expectedPodKeys[i],
				});
			}
		}
	});
});
