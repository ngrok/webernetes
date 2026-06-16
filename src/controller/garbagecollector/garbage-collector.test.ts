/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import * as k8s from "../../client";
import { isNotFoundError, NotFound } from "../../client/errors";
import { finalizerDeleteDependents } from "../../client/gen/apis/impls/delete";
import { newTestKubeClient, TestKubeClient, type ClientAction } from "../../client/test";
import type { EventRecorder } from "../../client-go/tools/record/event";
import { newFakeRecorder, type FakeRecorder } from "../../client-go/tools/record/fake";
import { defaultTypedControllerRateLimiter } from "../../client-go/util/workqueue/default-rate-limiters";
import {
	newTypedRateLimitingQueue,
	type TypedRateLimitingInterface,
} from "../../client-go/util/workqueue/rate-limiting-queue";
import * as context from "../../go/context";
import { browser } from "../../test/describe";
import { GarbageCollector } from "./garbage-collector";
import {
	createEvent,
	makeNode,
	newTestGraphBuilder,
	verifyGraphInvariants,
	withOwners,
} from "./garbage-collector-test-helpers";
import { GraphBuilder, type GraphBuilderQueues, type GraphEvent } from "./graph-builder";
import { identityFor, Node, type ModeledObject, type ObjectReference } from "./graph";
import { newReferenceCache } from "./uid-cache";

browser.describe("garbagecollector GarbageCollector", ({ ctx }) => {
	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go TestAttemptToDeleteItem.
	// ReplicationController is outside the current modeled resource set, so this uses a
	// missing apps/v1 ReplicaSet owner to exercise the same dangling-owner delete path.
	it("AttemptToDeleteItem", async () => {
		const pod = getPod("ToBeDeletedPod", [
			{
				kind: "ReplicaSet",
				name: "owner1",
				uid: "123",
				apiVersion: "apps/v1",
			},
		]);
		const [client, gc] = await setupGC(ctx, [pod]);
		try {
			const item = new Node({
				identity: {
					kind: pod.kind ?? "",
					apiVersion: pod.apiVersion ?? "",
					name: pod.metadata?.name ?? "",
					uid: pod.metadata?.uid ?? "",
					namespace: pod.metadata?.namespace ?? "",
				},
				owners: [],
				virtual: true,
			});

			const err = await gc.attemptToDeleteItem(ctx, item);
			expect(err).toBeUndefined();

			expect(item.virtual).toBe(true);
			expectActionSet(client, [
				"get apps/v1, Resource=replicasets ns=ns1 name=owner1",
				"delete /v1, Resource=pods ns=ns1 name=ToBeDeletedPod",
				"get /v1, Resource=pods ns=ns1 name=ToBeDeletedPod",
			]);
			expect(await readObject(client, identityFor(pod))).toBeUndefined();
		} finally {
			await gc.stop();
		}
	});

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go
	// TestAttemptToDeleteItemDeleteObjectNotFound.
	it("AttemptToDeleteItemDeleteObjectNotFound", async () => {
		const pod = getPod("ExternallyDeletedPod", [
			{
				kind: "ReplicaSet",
				name: "owner1",
				uid: "123",
				apiVersion: "apps/v1",
			},
		]);
		const [client, gc] = await setupGC(ctx, [pod]);
		client.addReactor("delete", "pods", () => [true, undefined, new NotFound()]);
		try {
			const item = new Node({
				identity: {
					kind: pod.kind ?? "",
					apiVersion: pod.apiVersion ?? "",
					name: pod.metadata?.name ?? "",
					uid: pod.metadata?.uid ?? "",
					namespace: pod.metadata?.namespace ?? "",
				},
				owners: [],
			});

			const err = await gc.attemptToDeleteItem(ctx, item);

			expect(err?.message).toBe("enqueued virtual delete event");
			expect(gc.dependencyGraphBuilder.graphChanges.len()).toBeGreaterThan(0);
		} finally {
			await gc.stop();
		}
	});

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go
	// TestAttemptToDeleteItemDeleteObjectNotFoundWaitingForDependents,
	// using a ReplicaSet owner because ReplicationController is outside the current
	// modeled resource set.
	it("AttemptToDeleteItemDeleteObjectNotFoundWaitingForDependents", async () => {
		const owner: k8s.V1ReplicaSet = {
			kind: "ReplicaSet",
			apiVersion: "apps/v1",
			metadata: {
				name: "owner1",
				namespace: "ns1",
				uid: "123",
				deletionTimestamp: new Date(),
				finalizers: [finalizerDeleteDependents],
			},
			spec: {
				selector: { matchLabels: { app: "owner1" } },
				template: {
					metadata: { labels: { app: "owner1" } },
					spec: { containers: [{ name: "container", image: "registry.k8s.io/pause:3.10" }] },
				},
			},
		};
		const pod = getPod("ExternallyDeletedPodFG", [
			{
				kind: "ReplicaSet",
				name: "owner1",
				uid: "123",
				apiVersion: "apps/v1",
				blockOwnerDeletion: true,
			},
		]);
		const [client, gc] = await setupGC(ctx, [owner, pod]);
		client.addReactor("delete", "pods", () => [true, undefined, new NotFound()]);
		try {
			const item = new Node({
				identity: {
					kind: pod.kind ?? "",
					apiVersion: pod.apiVersion ?? "",
					name: pod.metadata?.name ?? "",
					uid: pod.metadata?.uid ?? "",
					namespace: pod.metadata?.namespace ?? "",
				},
				owners: [],
			});

			const err = await gc.attemptToDeleteItem(ctx, item);

			expect(err?.message).toBe("enqueued virtual delete event");
			expect(gc.dependencyGraphBuilder.graphChanges.len()).toBeGreaterThan(0);
		} finally {
			await gc.stop();
		}
	});

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go TestAbsentOwnerCache.
	it("AbsentOwnerCache", async () => {
		const rc1Pod1 = getPod("rc1Pod1", [
			{
				kind: "ReplicaSet",
				name: "rc1",
				uid: "1",
				apiVersion: "apps/v1",
				controller: true,
			},
		]);
		const rc1Pod2 = getPod("rc1Pod2", [
			{
				kind: "ReplicaSet",
				name: "rc1",
				uid: "1",
				apiVersion: "apps/v1",
				controller: false,
			},
		]);
		const rc2Pod1 = getPod("rc2Pod1", [
			{
				kind: "ReplicaSet",
				name: "rc2",
				uid: "2",
				apiVersion: "apps/v1",
			},
		]);
		const rc3Pod1 = getPod("rc3Pod1", [
			{
				kind: "ReplicaSet",
				name: "rc3",
				uid: "3",
				apiVersion: "apps/v1",
			},
		]);
		const [client, gc] = await setupGC(ctx, [rc1Pod1, rc1Pod2, rc2Pod1, rc3Pod1]);
		try {
			gc.absentOwnerCache = newReferenceCache(2);

			await gc.attemptToDeleteItem(ctx, podToGCNode(rc1Pod1));
			await gc.attemptToDeleteItem(ctx, podToGCNode(rc2Pod1));
			// Reusing rc1 should refresh its UID cache entry.
			await gc.attemptToDeleteItem(ctx, podToGCNode(rc1Pod2));
			// Adding rc3 should evict rc2 from the two-entry UID cache.
			await gc.attemptToDeleteItem(ctx, podToGCNode(rc3Pod1));

			expect(
				gc.absentOwnerCache.has({
					namespace: "ns1",
					apiVersion: "apps/v1",
					kind: "ReplicaSet",
					name: "rc1",
					uid: "1",
				}),
			).toBe(true);
			expect(
				gc.absentOwnerCache.has({
					namespace: "ns1",
					apiVersion: "apps/v1",
					kind: "ReplicaSet",
					name: "rc2",
					uid: "2",
				}),
			).toBe(false);
			expect(
				gc.absentOwnerCache.has({
					namespace: "ns1",
					apiVersion: "apps/v1",
					kind: "ReplicaSet",
					name: "rc3",
					uid: "3",
				}),
			).toBe(true);
			const actions = takeActions(client);
			expect(
				actions.filter((action) => action === "get apps/v1, Resource=replicasets ns=ns1 name=rc1"),
			).toHaveLength(1);
		} finally {
			await gc.stop();
		}
	});

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go
	// TestUnblockOwnerReference. This intentionally verifies the local update path
	// because the fake client does not model Kubernetes strategic merge patch here.
	it("UnblockOwnerReference", async () => {
		const original = getPod("pod", [
			{ apiVersion: "", kind: "", name: "", uid: "1", blockOwnerDeletion: true },
			{ apiVersion: "", kind: "", name: "", uid: "2", blockOwnerDeletion: false },
			{ apiVersion: "", kind: "", name: "", uid: "3" },
		]);
		const [client, gc] = await setupGC(ctx, [original]);
		try {
			await gc.unblockOwnerReferences(ctx, original);

			const got = await client.corev1.readNamespacedPod({ namespace: "ns1", name: "pod" });
			expect(got.metadata?.ownerReferences).toEqual([
				{ apiVersion: "", kind: "", name: "", uid: "1", blockOwnerDeletion: false },
				{ apiVersion: "", kind: "", name: "", uid: "2", blockOwnerDeletion: false },
				{ apiVersion: "", kind: "", name: "", uid: "3" },
			]);
		} finally {
			await gc.stop();
		}
	});

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go attemptToDeleteWorker.
	// No direct upstream garbagecollector_test.go case isolates this branch.
	it("attemptToDeleteWorker forgets a virtual node that has become observed", async () => {
		const pod = getPod("observed", []);
		const [client, gc] = await setupGC(ctx, [pod]);
		try {
			const observed = objectToGCNode(pod);
			const virtualNode = new Node({ identity: observed.identity, virtual: true });
			gc.dependencyGraphBuilder.uidToNode.set(observed.identity.uid, observed);

			await expect(gc.attemptToDeleteWorker(ctx, virtualNode)).resolves.toBe("forgetItem");
			expect(takeActions(client)).toEqual([]);
		} finally {
			await gc.stop();
		}
	});

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go processDeletingDependentsItem.
	// No direct upstream garbagecollector_test.go case isolates this branch.
	it("processDeletingDependentsItem removes finalizer and finalizes object", async () => {
		const pod = getPod("owner", []);
		pod.metadata = {
			...pod.metadata,
			deletionTimestamp: new Date(1_000),
			finalizers: [finalizerDeleteDependents],
		};
		const [client, gc] = await setupGC(ctx, [pod]);
		try {
			const item = objectToGCNode(pod);
			item.markBeingDeleted();
			item.markDeletingDependents();

			await gc.processDeletingDependentsItem(ctx, item);

			let readError: unknown;
			try {
				await client.corev1.readNamespacedPod({ namespace: "ns1", name: "owner" });
			} catch (error) {
				readError = error;
			}
			expect(isNotFoundError(readError)).toBe(true);
			expect(takeActions(client)).not.toContain("delete /v1, Resource=pods ns=ns1 name=owner");
		} finally {
			await gc.stop();
		}
	});

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go TestConflictingData.
	// Webernetes omits upstream rows that require Secret, Role, or discovery behavior that
	// is not modeled here.
	it("ConflictingData", async () => {
		const deployment1apps = makeID("apps/v1", "Deployment", "ns1", "deployment1", "deploymentuid1");
		const deployment1extensions = makeID(
			"extensions/v1beta1",
			"Deployment",
			"ns1",
			"deployment1",
			"deploymentuid1",
		);
		const pod1ns1 = makeID("v1", "Pod", "ns1", "podname1", "poduid1");
		const pod2ns1 = makeID("v1", "Pod", "ns1", "podname2", "poduid2");
		const pod2ns2 = makeID("v1", "Pod", "ns2", "podname2", "poduid2");
		const node1 = makeID("v1", "Node", "", "nodename", "nodeuid1");

		const node1WithNamespace = makeID("v1", "Node", "ns1", "nodename", "nodeuid1");
		const pod1nonamespace = makeID("v1", "Pod", "", "podname1", "poduid1");

		const testScenarios: ConflictingDataScenario[] = [
			{
				name: "good child in ns1 -> cluster-scoped owner",
				steps: [
					createObjectInClient("", "v1", "nodes", "", makeMetadataObj(node1)),
					createObjectInClient("", "v1", "pods", "ns1", makeMetadataObj(pod1ns1, node1)),
					processEvent(makeAddEvent(pod1ns1, node1)),
					assertState({
						graphNodes: [
							makeNode(pod1ns1, withOwners(node1)),
							makeNode(node1WithNamespace, virtual),
						],
						pendingAttemptToDelete: [makeNode(node1WithNamespace, virtual)],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: ["get /v1, Resource=nodes name=nodename"],
						graphNodes: [
							makeNode(pod1ns1, withOwners(node1)),
							makeNode(node1WithNamespace, virtual),
						],
						pendingAttemptToDelete: [makeNode(node1WithNamespace, virtual)],
					}),
					processEvent(makeAddEvent(node1)),
					assertState({
						graphNodes: [makeNode(pod1ns1, withOwners(node1)), makeNode(node1)],
						pendingAttemptToDelete: [makeNode(node1WithNamespace, virtual)],
					}),
					processAttemptToDelete(1),
					assertState({
						graphNodes: [makeNode(pod1ns1, withOwners(node1)), makeNode(node1)],
					}),
				],
			},
			{
				name: "bad child in ns1 -> owner in ns2 (child first)",
				steps: [
					createObjectInClient("", "v1", "pods", "ns1", makeMetadataObj(pod1ns1, pod2ns1)),
					createObjectInClient("", "v1", "pods", "ns2", makeMetadataObj(pod2ns2)),
					processEvent(makeAddEvent(pod1ns1, pod2ns2)),
					assertState({
						graphNodes: [makeNode(pod1ns1, withOwners(pod2ns2)), makeNode(pod2ns1, virtual)],
						pendingAttemptToDelete: [makeNode(pod2ns1, virtual)],
					}),
					processEvent(makeAddEvent(pod2ns2)),
					assertState({
						graphNodes: [makeNode(pod1ns1, withOwners(pod2ns2)), makeNode(pod2ns2)],
						pendingAttemptToDelete: [makeNode(pod2ns1, virtual), makeNode(pod1ns1)],
						events: [
							`Warning OwnerRefInvalidNamespace ownerRef [v1/Pod, namespace: ns1, name: podname2, uid: poduid2] does not exist in namespace "ns1" involvedObject{kind=Pod,apiVersion=v1}`,
						],
					}),
					processAttemptToDelete(1),
					assertState({
						graphNodes: [makeNode(pod1ns1, withOwners(pod2ns2)), makeNode(pod2ns2)],
						pendingAttemptToDelete: [makeNode(pod1ns1)],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: [
							"get /v1, Resource=pods ns=ns1 name=podname1",
							"get /v1, Resource=pods ns=ns1 name=podname2",
							"delete /v1, Resource=pods ns=ns1 name=podname1",
						],
						graphNodes: [makeNode(pod1ns1, withOwners(pod2ns2)), makeNode(pod2ns2)],
						absentOwnerCache: [pod2ns1],
					}),
					processEvent(makeDeleteEvent(pod1ns1)),
					assertState({
						graphNodes: [makeNode(pod2ns2)],
						absentOwnerCache: [pod2ns1],
					}),
				],
			},
			{
				name: "bad child in ns1 -> owner in ns2 (owner first)",
				steps: [
					createObjectInClient("", "v1", "pods", "ns1", makeMetadataObj(pod1ns1, pod2ns1)),
					createObjectInClient("", "v1", "pods", "ns2", makeMetadataObj(pod2ns2)),
					processEvent(makeAddEvent(pod2ns2)),
					assertState({
						graphNodes: [makeNode(pod2ns2)],
					}),
					processEvent(makeAddEvent(pod1ns1, pod2ns1)),
					assertState({
						graphNodes: [makeNode(pod1ns1, withOwners(pod2ns1)), makeNode(pod2ns2)],
						pendingAttemptToDelete: [makeNode(pod1ns1)],
						events: [
							`Warning OwnerRefInvalidNamespace ownerRef [v1/Pod, namespace: ns1, name: podname2, uid: poduid2] does not exist in namespace "ns1" involvedObject{kind=Pod,apiVersion=v1}`,
						],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: [
							"get /v1, Resource=pods ns=ns1 name=podname1",
							"get /v1, Resource=pods ns=ns1 name=podname2",
							"delete /v1, Resource=pods ns=ns1 name=podname1",
						],
						graphNodes: [makeNode(pod1ns1, withOwners(pod2ns1)), makeNode(pod2ns2)],
						pendingAttemptToDelete: [],
						absentOwnerCache: [pod2ns1],
					}),
					processEvent(makeDeleteEvent(pod1ns1)),
					assertState({
						graphNodes: [makeNode(pod2ns2)],
						absentOwnerCache: [pod2ns1],
					}),
				],
			},
			{
				name: "bad cluster-scoped child -> owner in ns1 (child first)",
				steps: [
					createObjectInClient("", "v1", "nodes", "", makeMetadataObj(node1, pod1ns1)),
					createObjectInClient("", "v1", "pods", "ns1", makeMetadataObj(pod1ns1)),
					processEvent(makeAddEvent(node1, pod1ns1)),
					assertState({
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod1nonamespace, virtual),
						],
						pendingAttemptToDelete: [makeNode(pod1nonamespace, virtual)],
					}),
					processAttemptToDelete(1),
					assertState({
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod1nonamespace, virtual),
						],
						pendingAttemptToDelete: [],
					}),
					processEvent(makeAddEvent(pod1ns1)),
					assertState({
						graphNodes: [makeNode(node1, withOwners(pod1nonamespace)), makeNode(pod1ns1)],
						events: [
							`Warning OwnerRefInvalidNamespace ownerRef [v1/Pod, namespace: , name: podname1, uid: poduid1] does not exist in namespace "" involvedObject{kind=Node,apiVersion=v1}`,
						],
						pendingAttemptToDelete: [makeNode(node1, withOwners(pod1ns1))],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: ["get /v1, Resource=nodes name=nodename"],
						graphNodes: [makeNode(node1, withOwners(pod1nonamespace)), makeNode(pod1ns1)],
					}),
				],
			},
			{
				name: "bad cluster-scoped child -> owner in ns1 (owner first)",
				steps: [
					createObjectInClient("", "v1", "nodes", "", makeMetadataObj(node1, pod1ns1)),
					createObjectInClient("", "v1", "pods", "ns1", makeMetadataObj(pod1ns1)),
					processEvent(makeAddEvent(pod1ns1)),
					assertState({
						graphNodes: [makeNode(pod1ns1)],
					}),
					processEvent(makeAddEvent(node1, pod1ns1)),
					assertState({
						graphNodes: [makeNode(node1, withOwners(pod1nonamespace)), makeNode(pod1ns1)],
						events: [
							`Warning OwnerRefInvalidNamespace ownerRef [v1/Pod, namespace: , name: podname1, uid: poduid1] does not exist in namespace "" involvedObject{kind=Node,apiVersion=v1}`,
						],
						pendingAttemptToDelete: [makeNode(node1, withOwners(pod1ns1))],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: ["get /v1, Resource=nodes name=nodename"],
						graphNodes: [makeNode(node1, withOwners(pod1nonamespace)), makeNode(pod1ns1)],
					}),
				],
			},
			{
				name: "child -> existing owner with inaccessible API version (child first)",
				steps: [
					createObjectInClient(
						"apps",
						"v1",
						"deployments",
						"ns1",
						makeMetadataObj(deployment1apps),
					),
					createObjectInClient(
						"",
						"v1",
						"pods",
						"ns1",
						makeMetadataObj(pod1ns1, deployment1extensions),
					),
					processEvent(makeAddEvent(pod1ns1, deployment1extensions)),
					assertState({
						graphNodes: [
							makeNode(pod1ns1, withOwners(deployment1extensions)),
							makeNode(deployment1extensions, virtual),
						],
						pendingAttemptToDelete: [makeNode(deployment1extensions, virtual)],
					}),
					processAttemptToDelete(1),
					assertState({
						graphNodes: [
							makeNode(pod1ns1, withOwners(deployment1extensions)),
							makeNode(deployment1extensions, virtual),
						],
						pendingAttemptToDelete: [makeNode(deployment1extensions, virtual)],
					}),
					processEvent(makeAddEvent(deployment1apps)),
					assertState({
						graphNodes: [
							makeNode(pod1ns1, withOwners(deployment1extensions)),
							makeNode(deployment1apps),
						],
						pendingAttemptToDelete: [
							makeNode(deployment1extensions, virtual),
							makeNode(pod1ns1, withOwners(deployment1extensions)),
						],
					}),
					processAttemptToDelete(1),
					assertState({
						graphNodes: [
							makeNode(pod1ns1, withOwners(deployment1extensions)),
							makeNode(deployment1apps),
						],
						pendingAttemptToDelete: [makeNode(pod1ns1, withOwners(deployment1extensions))],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: ["get /v1, Resource=pods ns=ns1 name=podname1"],
						graphNodes: [
							makeNode(pod1ns1, withOwners(deployment1extensions)),
							makeNode(deployment1apps),
						],
						pendingAttemptToDelete: [makeNode(pod1ns1, withOwners(deployment1extensions))],
					}),
					deleteObjectFromClient("apps", "v1", "deployments", "ns1", "deployment1"),
					processEvent(makeDeleteEvent(deployment1apps)),
					assertState({
						graphNodes: [makeNode(pod1ns1, withOwners(deployment1extensions))],
						absentOwnerCache: [deployment1apps],
						pendingAttemptToDelete: [makeNode(pod1ns1, withOwners(deployment1extensions))],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: ["get /v1, Resource=pods ns=ns1 name=podname1"],
						graphNodes: [makeNode(pod1ns1, withOwners(deployment1extensions))],
						absentOwnerCache: [deployment1apps],
						pendingAttemptToDelete: [makeNode(pod1ns1, withOwners(deployment1extensions))],
					}),
				],
			},
			{
				name: "child -> existing owner with inaccessible API version (owner first)",
				steps: [
					createObjectInClient(
						"apps",
						"v1",
						"deployments",
						"ns1",
						makeMetadataObj(deployment1apps),
					),
					createObjectInClient(
						"",
						"v1",
						"pods",
						"ns1",
						makeMetadataObj(pod1ns1, deployment1extensions),
					),
					processEvent(makeAddEvent(deployment1apps)),
					assertState({
						graphNodes: [makeNode(deployment1apps)],
					}),
					processEvent(makeAddEvent(pod1ns1, deployment1extensions)),
					assertState({
						graphNodes: [
							makeNode(pod1ns1, withOwners(deployment1extensions)),
							makeNode(deployment1apps),
						],
						pendingAttemptToDelete: [makeNode(pod1ns1, withOwners(deployment1extensions))],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: ["get /v1, Resource=pods ns=ns1 name=podname1"],
						graphNodes: [
							makeNode(pod1ns1, withOwners(deployment1extensions)),
							makeNode(deployment1apps),
						],
						pendingAttemptToDelete: [makeNode(pod1ns1, withOwners(deployment1extensions))],
					}),
					deleteObjectFromClient("apps", "v1", "deployments", "ns1", "deployment1"),
					processEvent(makeDeleteEvent(deployment1apps)),
					assertState({
						graphNodes: [makeNode(pod1ns1, withOwners(deployment1extensions))],
						absentOwnerCache: [deployment1apps],
						pendingAttemptToDelete: [makeNode(pod1ns1, withOwners(deployment1extensions))],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: ["get /v1, Resource=pods ns=ns1 name=podname1"],
						graphNodes: [makeNode(pod1ns1, withOwners(deployment1extensions))],
						absentOwnerCache: [deployment1apps],
						pendingAttemptToDelete: [makeNode(pod1ns1, withOwners(deployment1extensions))],
					}),
				],
			},
			{
				name: "child -> non-existent owner with inaccessible API version (inaccessible parent apiVersion first)",
				steps: [
					createObjectInClient(
						"",
						"v1",
						"pods",
						"ns1",
						makeMetadataObj(pod1ns1, deployment1extensions),
					),
					createObjectInClient("", "v1", "pods", "ns1", makeMetadataObj(pod2ns1, deployment1apps)),
					processEvent(makeAddEvent(pod1ns1, deployment1extensions)),
					assertState({
						graphNodes: [
							makeNode(pod1ns1, withOwners(deployment1extensions)),
							makeNode(deployment1extensions, virtual),
						],
						pendingAttemptToDelete: [makeNode(deployment1extensions, virtual)],
					}),
					processEvent(makeAddEvent(pod2ns1, deployment1apps)),
					assertState({
						graphNodes: [
							makeNode(pod1ns1, withOwners(deployment1extensions)),
							makeNode(deployment1extensions, virtual),
							makeNode(pod2ns1, withOwners(deployment1apps)),
						],
						pendingAttemptToDelete: [
							makeNode(deployment1extensions, virtual),
							makeNode(pod2ns1, withOwners(deployment1apps)),
						],
					}),
					processAttemptToDelete(1),
					assertState({
						graphNodes: [
							makeNode(pod1ns1, withOwners(deployment1extensions)),
							makeNode(deployment1extensions, virtual),
							makeNode(pod2ns1, withOwners(deployment1apps)),
						],
						pendingAttemptToDelete: [
							makeNode(pod2ns1, withOwners(deployment1apps)),
							makeNode(deployment1extensions, virtual),
						],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: [
							"get /v1, Resource=pods ns=ns1 name=podname2",
							"get apps/v1, Resource=deployments ns=ns1 name=deployment1",
							"delete /v1, Resource=pods ns=ns1 name=podname2",
						],
						graphNodes: [
							makeNode(pod1ns1, withOwners(deployment1extensions)),
							makeNode(deployment1extensions, virtual),
							makeNode(pod2ns1, withOwners(deployment1apps)),
						],
						absentOwnerCache: [deployment1apps],
						pendingAttemptToDelete: [makeNode(deployment1extensions, virtual)],
					}),
					processEvent(makeDeleteEvent(pod2ns1)),
					assertState({
						graphNodes: [
							makeNode(pod1ns1, withOwners(deployment1extensions)),
							makeNode(deployment1extensions, virtual),
						],
						absentOwnerCache: [deployment1apps],
						pendingAttemptToDelete: [makeNode(deployment1extensions, virtual)],
					}),
					processAttemptToDelete(1),
					assertState({
						graphNodes: [
							makeNode(pod1ns1, withOwners(deployment1extensions)),
							makeNode(deployment1extensions, virtual),
						],
						absentOwnerCache: [deployment1apps],
						pendingAttemptToDelete: [makeNode(deployment1extensions, virtual)],
					}),
				],
			},
			{
				name: "child -> non-existent owner with inaccessible API version (accessible parent apiVersion first)",
				steps: [
					createObjectInClient(
						"",
						"v1",
						"pods",
						"ns1",
						makeMetadataObj(pod1ns1, deployment1extensions),
					),
					createObjectInClient("", "v1", "pods", "ns1", makeMetadataObj(pod2ns1, deployment1apps)),
					processEvent(makeAddEvent(pod2ns1, deployment1apps)),
					assertState({
						graphNodes: [
							makeNode(pod2ns1, withOwners(deployment1apps)),
							makeNode(deployment1apps, virtual),
						],
						pendingAttemptToDelete: [makeNode(deployment1apps, virtual)],
					}),
					processEvent(makeAddEvent(pod1ns1, deployment1extensions)),
					assertState({
						graphNodes: [
							makeNode(pod2ns1, withOwners(deployment1apps)),
							makeNode(deployment1apps, virtual),
							makeNode(pod1ns1, withOwners(deployment1extensions)),
						],
						pendingAttemptToDelete: [
							makeNode(deployment1apps, virtual),
							makeNode(pod1ns1, withOwners(deployment1extensions)),
						],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: ["get apps/v1, Resource=deployments ns=ns1 name=deployment1"],
						pendingGraphChanges: [makeVirtualDeleteEvent(deployment1apps)],
						graphNodes: [
							makeNode(pod2ns1, withOwners(deployment1apps)),
							makeNode(deployment1apps, virtual),
							makeNode(pod1ns1, withOwners(deployment1extensions)),
						],
						pendingAttemptToDelete: [makeNode(pod1ns1, withOwners(deployment1extensions))],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: ["get /v1, Resource=pods ns=ns1 name=podname1"],
						pendingGraphChanges: [makeVirtualDeleteEvent(deployment1apps)],
						graphNodes: [
							makeNode(pod2ns1, withOwners(deployment1apps)),
							makeNode(deployment1apps, virtual),
							makeNode(pod1ns1, withOwners(deployment1extensions)),
						],
						pendingAttemptToDelete: [makeNode(pod1ns1, withOwners(deployment1extensions))],
					}),
					processPendingGraphChanges(1),
					assertState({
						graphNodes: [
							makeNode(pod2ns1, withOwners(deployment1apps)),
							makeNode(deployment1extensions, virtual),
							makeNode(pod1ns1, withOwners(deployment1extensions)),
						],
						absentOwnerCache: [deployment1apps],
						pendingAttemptToDelete: [
							makeNode(pod1ns1, withOwners(deployment1extensions)),
							makeNode(pod2ns1, withOwners(deployment1apps)),
							makeNode(deployment1extensions, virtual),
						],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: ["get /v1, Resource=pods ns=ns1 name=podname1"],
						graphNodes: [
							makeNode(pod2ns1, withOwners(deployment1apps)),
							makeNode(deployment1extensions, virtual),
							makeNode(pod1ns1, withOwners(deployment1extensions)),
						],
						absentOwnerCache: [deployment1apps],
						pendingAttemptToDelete: [
							makeNode(pod2ns1, withOwners(deployment1apps)),
							makeNode(deployment1extensions, virtual),
							makeNode(pod1ns1, withOwners(deployment1extensions)),
						],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: [
							"get /v1, Resource=pods ns=ns1 name=podname2",
							"delete /v1, Resource=pods ns=ns1 name=podname2",
						],
						graphNodes: [
							makeNode(pod2ns1, withOwners(deployment1apps)),
							makeNode(deployment1extensions, virtual),
							makeNode(pod1ns1, withOwners(deployment1extensions)),
						],
						absentOwnerCache: [deployment1apps],
						pendingAttemptToDelete: [
							makeNode(deployment1extensions, virtual),
							makeNode(pod1ns1, withOwners(deployment1extensions)),
						],
					}),
					processAttemptToDelete(1),
					assertState({
						graphNodes: [
							makeNode(pod2ns1, withOwners(deployment1apps)),
							makeNode(deployment1extensions, virtual),
							makeNode(pod1ns1, withOwners(deployment1extensions)),
						],
						absentOwnerCache: [deployment1apps],
						pendingAttemptToDelete: [
							makeNode(pod1ns1, withOwners(deployment1extensions)),
							makeNode(deployment1extensions, virtual),
						],
					}),
					processEvent(makeDeleteEvent(pod2ns1)),
					assertState({
						graphNodes: [
							makeNode(deployment1extensions, virtual),
							makeNode(pod1ns1, withOwners(deployment1extensions)),
						],
						absentOwnerCache: [deployment1apps],
						pendingAttemptToDelete: [
							makeNode(pod1ns1, withOwners(deployment1extensions)),
							makeNode(deployment1extensions, virtual),
						],
					}),
				],
			},
			{
				name: "cluster-scoped bad child, namespaced good child, missing parent",
				steps: [
					createObjectInClient("", "v1", "pods", "ns1", makeMetadataObj(pod2ns1, pod1ns1)),
					createObjectInClient("", "v1", "nodes", "", makeMetadataObj(node1, pod1nonamespace)),
					processEvent(makeAddEvent(node1, pod1nonamespace)),
					assertState({
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod1nonamespace, virtual),
						],
						pendingAttemptToDelete: [makeNode(pod1nonamespace, virtual)],
					}),
					processEvent(makeAddEvent(pod2ns1, pod1ns1)),
					assertState({
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod2ns1, withOwners(pod1ns1)),
							makeNode(pod1nonamespace, virtual),
						],
						pendingAttemptToDelete: [
							makeNode(pod1nonamespace, virtual),
							makeNode(pod2ns1, withOwners(pod1ns1)),
						],
					}),
					processAttemptToDelete(1),
					assertState({
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod2ns1, withOwners(pod1ns1)),
							makeNode(pod1nonamespace, virtual),
						],
						pendingAttemptToDelete: [makeNode(pod2ns1, withOwners(pod1ns1))],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: [
							"get /v1, Resource=pods ns=ns1 name=podname2",
							"get /v1, Resource=pods ns=ns1 name=podname1",
							"delete /v1, Resource=pods ns=ns1 name=podname2",
						],
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod2ns1, withOwners(pod1ns1)),
							makeNode(pod1nonamespace, virtual),
						],
						absentOwnerCache: [pod1ns1],
					}),
					processEvent(makeDeleteEvent(pod2ns1, pod1ns1)),
					assertState({
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod1nonamespace, virtual),
						],
						absentOwnerCache: [pod1ns1],
					}),
				],
			},
			{
				name: "cluster-scoped bad child, namespaced good child, late observed parent",
				steps: [
					createObjectInClient("", "v1", "pods", "ns1", makeMetadataObj(pod1ns1)),
					createObjectInClient("", "v1", "pods", "ns1", makeMetadataObj(pod2ns1, pod1ns1)),
					createObjectInClient("", "v1", "nodes", "", makeMetadataObj(node1, pod1nonamespace)),
					processEvent(makeAddEvent(node1, pod1nonamespace)),
					assertState({
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod1nonamespace, virtual),
						],
						pendingAttemptToDelete: [makeNode(pod1nonamespace, virtual)],
					}),
					processEvent(makeAddEvent(pod2ns1, pod1ns1)),
					assertState({
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod2ns1, withOwners(pod1ns1)),
							makeNode(pod1nonamespace, virtual),
						],
						pendingAttemptToDelete: [
							makeNode(pod1nonamespace, virtual),
							makeNode(pod2ns1, withOwners(pod1ns1)),
						],
					}),
					processAttemptToDelete(1),
					assertState({
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod2ns1, withOwners(pod1ns1)),
							makeNode(pod1nonamespace, virtual),
						],
						pendingAttemptToDelete: [makeNode(pod2ns1, withOwners(pod1ns1))],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: [
							"get /v1, Resource=pods ns=ns1 name=podname2",
							"get /v1, Resource=pods ns=ns1 name=podname1",
						],
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod2ns1, withOwners(pod1ns1)),
							makeNode(pod1nonamespace, virtual),
						],
					}),
					processEvent(makeAddEvent(pod1ns1)),
					assertState({
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod2ns1, withOwners(pod1ns1)),
							makeNode(pod1ns1),
						],
						events: [
							`Warning OwnerRefInvalidNamespace ownerRef [v1/Pod, namespace: , name: podname1, uid: poduid1] does not exist in namespace "" involvedObject{kind=Node,apiVersion=v1}`,
						],
						pendingAttemptToDelete: [makeNode(node1, withOwners(pod1nonamespace))],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: ["get /v1, Resource=nodes name=nodename"],
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod2ns1, withOwners(pod1ns1)),
							makeNode(pod1ns1),
						],
					}),
				],
			},
			{
				name: "namespaced good child, cluster-scoped bad child, missing parent",
				steps: [
					createObjectInClient("", "v1", "pods", "ns1", makeMetadataObj(pod2ns1, pod1ns1)),
					createObjectInClient("", "v1", "nodes", "", makeMetadataObj(node1, pod1nonamespace)),
					processEvent(makeAddEvent(pod2ns1, pod1ns1)),
					assertState({
						graphNodes: [makeNode(pod2ns1, withOwners(pod1ns1)), makeNode(pod1ns1, virtual)],
						pendingAttemptToDelete: [makeNode(pod1ns1, virtual)],
					}),
					processEvent(makeAddEvent(node1, pod1nonamespace)),
					assertState({
						graphNodes: [
							makeNode(pod2ns1, withOwners(pod1ns1)),
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod1ns1, virtual),
						],
						pendingAttemptToDelete: [
							makeNode(pod1ns1, virtual),
							makeNode(node1, withOwners(pod1nonamespace)),
						],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: ["get /v1, Resource=pods ns=ns1 name=podname1"],
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod2ns1, withOwners(pod1ns1)),
							makeNode(pod1ns1, virtual),
						],
						pendingGraphChanges: [makeVirtualDeleteEvent(pod1ns1)],
						pendingAttemptToDelete: [makeNode(node1, withOwners(pod1nonamespace))],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: ["get /v1, Resource=nodes name=nodename"],
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod2ns1, withOwners(pod1ns1)),
							makeNode(pod1ns1, virtual),
						],
						pendingGraphChanges: [makeVirtualDeleteEvent(pod1ns1)],
					}),
					processPendingGraphChanges(1),
					assertState({
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod2ns1, withOwners(pod1ns1)),
							makeNode(pod1nonamespace, virtual),
						],
						absentOwnerCache: [pod1ns1],
						pendingAttemptToDelete: [
							makeNode(pod2ns1, withOwners(pod1ns1)),
							makeNode(pod1nonamespace, virtual),
						],
					}),
					processAttemptToDelete(1),
					assertState({
						clientActions: [
							"get /v1, Resource=pods ns=ns1 name=podname2",
							"delete /v1, Resource=pods ns=ns1 name=podname2",
						],
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod2ns1, withOwners(pod1ns1)),
							makeNode(pod1nonamespace, virtual),
						],
						absentOwnerCache: [pod1ns1],
						pendingAttemptToDelete: [makeNode(pod1nonamespace, virtual)],
					}),
					processEvent(makeDeleteEvent(pod2ns1, pod1ns1)),
					assertState({
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod1nonamespace, virtual),
						],
						absentOwnerCache: [pod1ns1],
						pendingAttemptToDelete: [makeNode(pod1nonamespace, virtual)],
					}),
					processAttemptToDelete(1),
					assertState({
						graphNodes: [
							makeNode(node1, withOwners(pod1nonamespace)),
							makeNode(pod1nonamespace, virtual),
						],
						absentOwnerCache: [pod1ns1],
					}),
				],
			},
		];

		for (const scenario of testScenarios) {
			const eventRecorder = newFakeRecorder(100);
			eventRecorder.includeObject = true;
			const [client, gc] = await setupGC(ctx, [], eventRecorder);
			try {
				const stepContext: StepContext = {
					ctx,
					client,
					gc,
					eventRecorder,
					attemptToDelete: gc.dependencyGraphBuilder.attemptToDelete as TrackingWorkqueue<Node>,
					attemptToOrphan: gc.dependencyGraphBuilder.attemptToOrphan as TrackingWorkqueue<Node>,
					graphChanges: gc.dependencyGraphBuilder.graphChanges as TrackingWorkqueue<GraphEvent>,
				};
				for (const [i, step] of scenario.steps.entries()) {
					try {
						await step.check(stepContext);
						verifyGraphInvariants(`after step ${i}`, gc.dependencyGraphBuilder.uidToNode);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						throw new Error(`${scenario.name}: ${step.name}: ${message}`, {
							cause: error,
						});
					}
				}
			} finally {
				await gc.stop();
			}
		}
	});

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go TestProcessEvent.
	it("ProcessEvent", async () => {
		const testScenarios = [
			{
				name: "test1",
				events: [
					createEvent("add", "1", []),
					createEvent("add", "2", ["1"]),
					createEvent("add", "3", ["1", "2"]),
				],
			},
			{
				name: "test2",
				events: [
					createEvent("add", "1", []),
					createEvent("add", "2", ["1"]),
					createEvent("add", "3", ["1", "2"]),
					createEvent("add", "4", ["2"]),
					createEvent("delete", "2", ["doesn't matter"]),
				],
			},
			{
				name: "test3",
				events: [
					createEvent("add", "1", []),
					createEvent("add", "2", ["1"]),
					createEvent("add", "3", ["1", "2"]),
					createEvent("add", "4", ["3"]),
					createEvent("update", "2", ["4"]),
				],
			},
			{
				name: "reverse test2",
				events: [
					createEvent("add", "4", ["2"]),
					createEvent("add", "3", ["1", "2"]),
					createEvent("add", "2", ["1"]),
					createEvent("add", "1", []),
					createEvent("delete", "2", ["doesn't matter"]),
				],
			},
		];

		for (const scenario of testScenarios) {
			const dependencyGraphBuilder = newTestGraphBuilder();
			for (const event of scenario.events) {
				dependencyGraphBuilder.graphChanges.add(event);
				await dependencyGraphBuilder.processGraphChanges();
				verifyGraphInvariants(scenario.name, dependencyGraphBuilder.uidToNode);
			}
		}
	});
});

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go TestConflictingData testScenarios element.
interface ConflictingDataScenario {
	name: string;
	steps: Step[];
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go stepContext.
interface StepContext {
	ctx: context.Context;
	client: TestKubeClient;
	gc: GarbageCollector;
	eventRecorder: FakeRecorder;
	attemptToDelete: TrackingWorkqueue<Node>;
	attemptToOrphan: TrackingWorkqueue<Node>;
	graphChanges: TrackingWorkqueue<GraphEvent>;
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go step.
interface Step {
	name: string;
	check(stepContext: StepContext): Promise<void>;
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go state.
interface State {
	events?: string[];
	clientActions?: string[];
	graphNodes?: Node[];
	pendingGraphChanges?: GraphEvent[];
	pendingAttemptToDelete?: Node[];
	pendingAttemptToOrphan?: Node[];
	absentOwnerCache?: ObjectReference[];
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go virtual.
function virtual(node: Node): Node {
	node.virtual = true;
	return node;
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go createObjectInClient.
function createObjectInClient(
	group: string,
	version: string,
	resource: string,
	namespace: string,
	object: ModeledObject,
): Step {
	return {
		name: "createObjectInClient",
		async check({ client }) {
			expect(object.apiVersion).toBe(group ? `${group}/${version}` : version);
			expect(resourceForObject(object)).toBe(resource);
			expect(object.metadata?.namespace ?? "").toBe(namespace);
			await putMetadataObjectInClient(client, resource, namespace, object);
			client.clearActions();
		},
	};
}

// Webernetes local equivalent of upstream's metadataClient tracker create path.
async function putMetadataObjectInClient(
	client: TestKubeClient,
	resource: string,
	namespace: string,
	object: ModeledObject,
): Promise<void> {
	const name = object.metadata?.name;
	if (!name) {
		throw new Error("object is missing metadata.name");
	}
	const key =
		namespace.length > 0
			? `/registry/${resource}/${namespace}/${name}`
			: `/registry/${resource}/${name}`;
	await client.kubeConfig.etcd.put(key).value(JSON.stringify(structuredClone(object)));
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go deleteObjectFromClient.
function deleteObjectFromClient(
	group: string,
	version: string,
	resource: string,
	namespace: string,
	name: string,
): Step {
	return {
		name: "deleteObjectFromClient",
		async check({ client }) {
			if (group === "apps" && version === "v1" && resource === "deployments") {
				await client.appsv1.deleteNamespacedDeployment({ namespace, name });
				client.clearActions();
				return;
			}
			if (group === "" && version === "v1" && resource === "pods") {
				await client.corev1.deleteNamespacedPod({ namespace, name });
				client.clearActions();
				return;
			}
			if (group === "" && version === "v1" && resource === "nodes") {
				await client.corev1.deleteNode({ name });
				client.clearActions();
				return;
			}
			throw new Error(`unsupported test delete ${group}/${version}/${resource}`);
		},
	};
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go makeMetadataObj.
function makeMetadataObj(identity: ObjectReference, ...owners: ObjectReference[]): ModeledObject {
	return {
		apiVersion: identity.apiVersion,
		kind: identity.kind,
		metadata: {
			name: identity.name,
			namespace: identity.namespace || undefined,
			uid: identity.uid,
			ownerReferences: owners.length > 0 ? owners.map((owner) => ownerReference(owner)) : undefined,
		},
	} as ModeledObject;
}

// Webernetes local helper for validating the upstream-style createObjectInClient
// group/version/resource arguments against simulator objects.
function resourceForObject(object: ModeledObject): string {
	const identity = identityFor(object);
	if (!identity) {
		throw new Error("object is missing identity");
	}
	if (identity.apiVersion === "apps/v1" && identity.kind === "Deployment") {
		return "deployments";
	}
	if (identity.apiVersion === "apps/v1" && identity.kind === "ReplicaSet") {
		return "replicasets";
	}
	if (identity.apiVersion === "v1" && identity.kind === "Node") {
		return "nodes";
	}
	if (identity.apiVersion === "v1" && identity.kind === "Pod") {
		return "pods";
	}
	if (identity.apiVersion === "v1" && identity.kind === "Service") {
		return "services";
	}
	if (identity.apiVersion === "discovery.k8s.io/v1" && identity.kind === "EndpointSlice") {
		return "endpointslices";
	}
	throw new Error(`unsupported test object ${identity.apiVersion}/${identity.kind}`);
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go makeAddEvent.
function makeAddEvent(identity: ObjectReference, ...owners: ObjectReference[]): GraphEvent {
	return { eventType: "add", obj: makeMetadataObj(identity, ...owners) };
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go makeDeleteEvent.
function makeDeleteEvent(identity: ObjectReference, ...owners: ObjectReference[]): GraphEvent {
	return { eventType: "delete", obj: makeMetadataObj(identity, ...owners) };
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go makeVirtualDeleteEvent.
function makeVirtualDeleteEvent(
	identity: ObjectReference,
	...owners: ObjectReference[]
): GraphEvent {
	const event = makeDeleteEvent(identity, ...owners);
	event.virtual = true;
	return event;
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go processEvent.
function processEvent(event: GraphEvent): Step {
	return {
		name: "processEvent",
		async check({ gc }) {
			expect(gc.dependencyGraphBuilder.graphChanges.len()).toBe(0);
			gc.dependencyGraphBuilder.graphChanges.add(event);
			await gc.dependencyGraphBuilder.processGraphChanges();
		},
	};
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go processPendingGraphChanges.
function processPendingGraphChanges(count: number): Step {
	return {
		name: "processPendingGraphChanges",
		async check({ gc }) {
			if (count <= 0) {
				while (gc.dependencyGraphBuilder.graphChanges.len() !== 0) {
					await gc.dependencyGraphBuilder.processGraphChanges();
				}
				return;
			}
			for (let i = 0; i < count; i++) {
				if (gc.dependencyGraphBuilder.graphChanges.len() === 0) {
					expect.fail(`expected at least ${count} pending changes, got ${i + 1}`);
				}
				await gc.dependencyGraphBuilder.processGraphChanges();
			}
		},
	};
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go processAttemptToDelete.
function processAttemptToDelete(count: number): Step {
	return {
		name: "processAttemptToDelete",
		async check({ ctx, gc }) {
			if (count <= 0) {
				while (gc.dependencyGraphBuilder.attemptToDelete.len() !== 0) {
					await gc.processAttemptToDeleteWorker(ctx);
				}
				return;
			}
			for (let i = 0; i < count; i++) {
				expect(gc.dependencyGraphBuilder.attemptToDelete.len()).toBeGreaterThan(0);
				await gc.processAttemptToDeleteWorker(ctx);
			}
		},
	};
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go assertState.
function assertState(s: State): Step {
	return {
		name: "assertState",
		async check({ attemptToDelete, attemptToOrphan, client, eventRecorder, gc, graphChanges }) {
			{
				const expectedAbsentOwnerCache = s.absentOwnerCache ?? [];
				for (const absent of expectedAbsentOwnerCache) {
					expect(gc.absentOwnerCache.has(absent)).toBe(true);
				}
				expect(gc.absentOwnerCache.keys()).toEqual(expectedAbsentOwnerCache);
			}

			{
				const actualEvents = takeEvents(eventRecorder);
				expect(actualEvents).toEqual(s.events ?? []);
			}

			{
				const actualClientActions = takeActions(client);
				if (s.clientActions || actualClientActions.length > 0) {
					expect(actualClientActions).toEqual(s.clientActions ?? []);
				}
			}

			{
				const expectedGraphNodes = s.graphNodes ?? [];
				expect(gc.dependencyGraphBuilder.uidToNode.size).toBe(expectedGraphNodes.length);
				for (const expected of expectedGraphNodes) {
					const actual = gc.dependencyGraphBuilder.uidToNode.get(expected.identity.uid);
					expect(actual?.identity).toEqual(expected.identity);
					expect(actual?.virtual).toBe(expected.virtual);
					if (expected.getOwners().length > 0 || (actual?.getOwners().length ?? 0) > 0) {
						expect(actual?.getOwners()).toEqual(expected.getOwners());
					}
				}
			}

			{
				const expectedPendingGraphChanges = s.pendingGraphChanges ?? [];
				for (const [i, e] of expectedPendingGraphChanges.entries()) {
					if (graphChanges.pendingList.length < i + 1) {
						expect.fail(
							`graphChanges: expected ${expectedPendingGraphChanges.length} events, got ${graphChanges.len()}`,
						);
					}
					const a = graphChanges.pendingList[i];
					expect(a).toEqual(e);
				}
				if (graphChanges.len() > expectedPendingGraphChanges.length) {
					for (const [i, actual] of graphChanges.pendingList
						.slice(expectedPendingGraphChanges.length)
						.entries()) {
						expect.fail(
							`graphChanges[${expectedPendingGraphChanges.length + i}]: unexpected event: ${String(actual)}`,
						);
					}
				}
			}

			{
				const expectedPendingAttemptToDelete = s.pendingAttemptToDelete ?? [];
				for (const [i, expected] of expectedPendingAttemptToDelete.entries()) {
					if (attemptToDelete.len() < i + 1) {
						expect.fail(
							`attemptToDelete: expected ${expectedPendingAttemptToDelete.length} events, got ${attemptToDelete.len()}`,
						);
					}
					const actual = attemptToDelete.pendingList[i];
					expect(actual?.identity).toEqual(expected.identity);
					expect(actual?.virtual).toBe(expected.virtual);
				}
				if (attemptToDelete.len() > expectedPendingAttemptToDelete.length) {
					for (const [i, actual] of attemptToDelete.pendingList
						.slice(expectedPendingAttemptToDelete.length)
						.entries()) {
						expect.fail(
							`attemptToDelete[${expectedPendingAttemptToDelete.length + i}]: unexpected node: ${String(actual.identity.uid)}`,
						);
					}
				}
			}

			{
				const expectedPendingAttemptToOrphan = s.pendingAttemptToOrphan ?? [];
				for (const [i, expected] of expectedPendingAttemptToOrphan.entries()) {
					if (attemptToOrphan.len() < i + 1) {
						expect.fail(
							`attemptToOrphan: expected ${expectedPendingAttemptToOrphan.length} events, got ${attemptToOrphan.len()}`,
						);
					}
					const actual = attemptToOrphan.pendingList[i];
					expect(actual?.identity).toEqual(expected.identity);
				}
				if (attemptToOrphan.len() > expectedPendingAttemptToOrphan.length) {
					for (const [i, actual] of attemptToOrphan.pendingList
						.slice(expectedPendingAttemptToOrphan.length)
						.entries()) {
						expect.fail(
							`attemptToOrphan[${expectedPendingAttemptToOrphan.length + i}]: unexpected node: ${String(actual.identity.uid)}`,
						);
					}
				}
			}
		},
	};
}

// Models the event-draining block inside upstream assertState.
function takeEvents(eventRecorder: FakeRecorder): string[] {
	const events: string[] = [];
	for (;;) {
		const event = eventRecorder.events?.tryReceive();
		if (!event?.ok) {
			return events;
		}
		events.push(event.value);
	}
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go trackingWorkqueue.
class TrackingWorkqueue<T> implements TypedRateLimitingInterface<T> {
	private readonly limiter: TypedRateLimitingInterface<T>;
	readonly pendingList: T[] = [];
	private readonly pendingMap = new Map<T, undefined>();

	constructor() {
		this.limiter = newTypedRateLimitingQueue(defaultTypedControllerRateLimiter<T>());
	}

	add(item: T): void {
		this.queue(item);
		this.limiter.add(item);
	}

	async addAfter(item: T, _durationMs: number): Promise<void> {
		this.add(item);
	}

	async addRateLimited(item: T): Promise<void> {
		this.add(item);
	}

	async get(): Promise<[item: T | undefined, shutdown: boolean]> {
		const [item, shutdown] = await this.limiter.get();
		if (item !== undefined) {
			this.dequeue(item);
		}
		return [item, shutdown];
	}

	done(item: T): void {
		this.limiter.done(item);
	}

	forget(item: T): void {
		this.limiter.forget(item);
	}

	numRequeues(_item: T): number {
		return 0;
	}

	len(): number {
		if (this.pendingList.length !== this.pendingMap.size) {
			throw new Error(
				`pendingList != pendingMap: ${this.pendingList.length} / ${this.pendingMap.size}`,
			);
		}
		if (this.pendingList.length !== this.limiter.len()) {
			throw new Error(
				`pendingList != limiter.len(): ${this.pendingList.length} / ${this.limiter.len()}`,
			);
		}
		return this.pendingList.length;
	}

	async shutDown(): Promise<void> {
		await this.limiter.shutDown();
	}

	async shutDownWithDrain(): Promise<void> {
		await this.limiter.shutDownWithDrain();
	}

	shuttingDown(): boolean {
		return this.limiter.shuttingDown();
	}

	private queue(item: T): void {
		if (this.pendingMap.has(item)) {
			return;
		}
		this.pendingMap.set(item, undefined);
		this.pendingList.push(item);
	}

	private dequeue(item: T): void {
		if (!this.pendingMap.has(item)) {
			return;
		}
		this.pendingMap.delete(item);
		const index = this.pendingList.indexOf(item);
		if (index >= 0) {
			this.pendingList.splice(index, 1);
		}
	}
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go newTrackingWorkqueue.
function newTrackingWorkqueue<T>(): TrackingWorkqueue<T> {
	return new TrackingWorkqueue<T>();
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go getPod.
function getPod(podName: string, ownerReferences: k8s.V1OwnerReference[]): k8s.V1Pod {
	return {
		kind: "Pod",
		apiVersion: "v1",
		metadata: {
			name: podName,
			namespace: "ns1",
			uid: "456",
			ownerReferences,
		},
		spec: {
			containers: [{ name: "container", image: "registry.k8s.io/pause:3.10" }],
		},
	};
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go makeID.
function makeID(
	apiVersion: string,
	kind: string,
	namespace: string,
	name: string,
	uid: string,
): ObjectReference {
	return { apiVersion, kind, namespace, name, uid };
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go podToGCNode.
function podToGCNode(pod: k8s.V1Pod): Node {
	const identity = identityFor(pod);
	if (!identity) {
		throw new Error("pod is missing identity");
	}
	return new Node({ identity, owners: [] });
}

// Webernetes local helper for tests that need a GC node from non-Pod modeled resources.
function objectToGCNode(object: ModeledObject): Node {
	const identity = identityFor(object);
	if (!identity) {
		throw new Error("object is missing identity");
	}
	return new Node({
		identity,
		owners: object.metadata?.ownerReferences ?? [],
		beingDeleted: object.metadata?.deletionTimestamp !== undefined,
	});
}

// Models the embedded metav1.OwnerReference in upstream objectReference.
function ownerReference(
	reference: ObjectReference,
	blockOwnerDeletion?: boolean,
): k8s.V1OwnerReference {
	return {
		apiVersion: reference.apiVersion,
		kind: reference.kind,
		name: reference.name,
		uid: reference.uid,
		blockOwnerDeletion,
	};
}

type TestGC = [client: TestKubeClient, gc: GarbageCollector];

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go
// setupGC, with API objects seeded into the simulator instead of passing a REST
// client config. This is different to how upstream works, but we had to
// make a lot of concessions because we don't have a REST API surface.
async function setupGC(
	ctx: context.Context,
	objects: ModeledObject[],
	eventRecorder?: EventRecorder,
): Promise<TestGC> {
	const [client, kubeConfig] = await newTestKubeClient(ctx, objects);
	const queues: GraphBuilderQueues = {
		graphChanges: newTrackingWorkqueue<GraphEvent>(),
		attemptToDelete: newTrackingWorkqueue<Node>(),
		attemptToOrphan: newTrackingWorkqueue<Node>(),
	};
	const graphBuilder = new GraphBuilder(client, kubeConfig, eventRecorder, queues);
	const gc = new GarbageCollector(client, kubeConfig, graphBuilder);
	return [client, gc];
}

// Webernetes local helper for reading simulator objects by GC objectReference.
async function readObject(
	client: TestKubeClient,
	reference: ObjectReference | undefined,
): Promise<ModeledObject | undefined> {
	if (!reference) {
		return undefined;
	}
	try {
		if (reference.apiVersion === "apps/v1" && reference.kind === "Deployment") {
			return await client.appsv1.readNamespacedDeployment(reference);
		}
		if (reference.apiVersion === "apps/v1" && reference.kind === "ReplicaSet") {
			return await client.appsv1.readNamespacedReplicaSet(reference);
		}
		if (reference.apiVersion === "v1" && reference.kind === "Node") {
			return await client.corev1.readNode({ name: reference.name });
		}
		if (reference.apiVersion === "v1" && reference.kind === "Pod") {
			return await client.corev1.readNamespacedPod(reference);
		}
		if (reference.apiVersion === "v1" && reference.kind === "Service") {
			return await client.corev1.readNamespacedService(reference);
		}
		if (reference.apiVersion === "discovery.k8s.io/v1" && reference.kind === "EndpointSlice") {
			return await client.discoveryv1.readNamespacedEndpointSlice(reference);
		}
		throw new Error(`unsupported test object ${reference.apiVersion}/${reference.kind}`);
	} catch (error) {
		if (isNotFoundError(error)) {
			return undefined;
		}
		throw error;
	}
}

// Models the action-draining portions of upstream action assertions.
function takeActions(client: TestKubeClient): string[] {
	const actions = client.actions().map((recorded) => formatAction(recorded));
	client.clearActions();
	return actions;
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector_test.go TestAttemptToDeleteItem expectedActionSet.
function expectActionSet(client: TestKubeClient, expectedActions: string[]): void {
	expect(new Set(takeActions(client))).toEqual(new Set(expectedActions));
}

// Models upstream assertState's client action string formatting for the local
// TestKubeClient action recorder.
function formatAction(action: ClientAction): string {
	const request = action.request as { namespace?: string; name?: string };
	const parts = [
		action.verb,
		`${actionResourcePath(action.resource)},`,
		`Resource=${action.resource}`,
	];
	if (request?.namespace !== undefined) {
		parts.push(`ns=${request.namespace}`);
	}
	if (request?.name) {
		parts.push(`name=${request.name}`);
	}
	return parts.join(" ");
}

// Webernetes local helper for translating fake-client resource names into
// upstream-style action resource paths.
function actionResourcePath(resource: string): string {
	if (resource === "deployments" || resource === "replicasets") {
		return "apps/v1";
	}
	if (resource === "endpointslices") {
		return "discovery.k8s.io/v1";
	}
	return "/v1";
}
