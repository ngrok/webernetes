/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import * as k8s from "../../client";
import {
	defaultTypedControllerRateLimiter,
	newTypedRateLimitingQueueWithConfig,
	type TypedRateLimitingInterface,
} from "../../client-go/util/workqueue/queue";
import {
	finalizerDeleteDependents,
	finalizerOrphanDependents,
} from "../../client/gen/apis/impls/delete";
import { getClock } from "../../clock-context";
import type * as context from "../../go/context";
import { deepEqual } from "../../deep-equal";
import {
	hasDeleteDependentsFinalizer,
	identityFor,
	Node,
	type ModeledObject,
	ownerReferenceCoordinates,
	ownerReferenceMatchesCoordinates,
	type ObjectReference,
} from "./graph";
import { newReferenceCache, type ReferenceCache } from "./uid-cache";

export type EventType = "add" | "update" | "delete";

export interface GraphEvent {
	eventType: EventType;
	obj: ModeledObject;
	oldObj?: ModeledObject;
	virtual?: boolean;
}

interface OwnerRefPair {
	oldRef: k8s.V1OwnerReference;
	newRef: k8s.V1OwnerReference;
}

// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go GraphBuilder.
export class GraphBuilder {
	readonly graphChanges: TypedRateLimitingInterface<GraphEvent>;
	readonly uidToNode = new Map<string, Node>();
	readonly attemptToDelete: TypedRateLimitingInterface<Node>;
	readonly attemptToOrphan: TypedRateLimitingInterface<Node>;
	readonly absentOwnerCache: ReferenceCache = newReferenceCache(500);

	private deploymentInformer: k8s.Informer<k8s.V1Deployment> | undefined;
	private replicaSetInformer: k8s.Informer<k8s.V1ReplicaSet> | undefined;
	private podInformer: k8s.Informer<k8s.V1Pod> | undefined;
	private serviceInformer: k8s.Informer<k8s.V1Service> | undefined;
	private endpointSliceInformer: k8s.Informer<k8s.V1EndpointSlice> | undefined;
	private readonly deployments = new Map<string, k8s.V1Deployment>();
	private readonly replicaSets = new Map<string, k8s.V1ReplicaSet>();
	private readonly pods = new Map<string, k8s.V1Pod>();
	private readonly services = new Map<string, k8s.V1Service>();
	private readonly endpointSlices = new Map<string, k8s.V1EndpointSlice>();

	constructor(
		private readonly api: k8s.KubeClient,
		private readonly kubeConfig: k8s.KubeConfig,
	) {
		const clock = getClock(kubeConfig.options.ctx);
		this.graphChanges = newTypedRateLimitingQueueWithConfig(
			defaultTypedControllerRateLimiter<GraphEvent>(),
			{ clock },
		);
		this.attemptToDelete = newTypedRateLimitingQueueWithConfig(
			defaultTypedControllerRateLimiter<Node>(),
			{ clock },
		);
		this.attemptToOrphan = newTypedRateLimitingQueueWithConfig(
			defaultTypedControllerRateLimiter<Node>(),
			{ clock },
		);
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go Run.
	async run(ctx: context.Context): Promise<void> {
		await this.startMonitors(ctx);
		void this.runProcessGraphChanges();
	}

	async stop(): Promise<void> {
		await this.deploymentInformer?.stop();
		await this.replicaSetInformer?.stop();
		await this.podInformer?.stop();
		await this.serviceInformer?.stop();
		await this.endpointSliceInformer?.stop();
		await this.graphChanges.shutDown();
		await this.attemptToDelete.shutDown();
		await this.attemptToOrphan.shutDown();
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go startMonitors.
	private async startMonitors(_ctx: context.Context): Promise<void> {
		this.deploymentInformer = k8s.makeInformer(
			this.kubeConfig,
			"/apis/apps/v1/deployments",
			async () => await this.api.appsv1.listDeploymentForAllNamespaces(),
		);
		this.replicaSetInformer = k8s.makeInformer(
			this.kubeConfig,
			"/apis/apps/v1/replicasets",
			async () => await this.api.appsv1.listReplicaSetForAllNamespaces(),
		);
		this.podInformer = k8s.makeInformer(
			this.kubeConfig,
			"/api/v1/pods",
			async () => await this.api.corev1.listPodForAllNamespaces(),
		);
		this.serviceInformer = k8s.makeInformer(
			this.kubeConfig,
			"/api/v1/services",
			async () => await this.api.corev1.listServiceForAllNamespaces(),
		);
		this.endpointSliceInformer = k8s.makeInformer(
			this.kubeConfig,
			"/apis/discovery.k8s.io/v1/endpointslices",
			async () => await this.api.discoveryv1.listEndpointSliceForAllNamespaces(),
		);

		this.watch(this.deploymentInformer, this.deployments);
		this.watch(this.replicaSetInformer, this.replicaSets);
		this.watch(this.podInformer, this.pods);
		this.watch(this.serviceInformer, this.services);
		this.watch(this.endpointSliceInformer, this.endpointSlices);

		await this.deploymentInformer.start();
		await this.replicaSetInformer.start();
		await this.podInformer.start();
		await this.serviceInformer.start();
		await this.endpointSliceInformer.start();
	}

	private watch<T extends ModeledObject>(informer: k8s.Informer<T>, cache: Map<string, T>): void {
		informer.on("add", (object) => this.upsert(cache, object, "add"));
		informer.on("update", (object) => this.upsert(cache, object, "update"));
		informer.on("delete", (object) => this.delete(cache, object));
	}

	private upsert<T extends ModeledObject>(
		cache: Map<string, T>,
		object: T,
		eventType: "add" | "update",
	): void {
		const key = objectKey(object);
		const oldObj = cache.get(key);
		cache.set(key, object);
		this.graphChanges.add({ eventType, obj: object, oldObj });
	}

	private delete<T extends ModeledObject>(cache: Map<string, T>, object: T): void {
		cache.delete(objectKey(object));
		this.graphChanges.add({ eventType: "delete", obj: object });
	}

	objects(): ModeledObject[] {
		return [
			...this.deployments.values(),
			...this.replicaSets.values(),
			...this.pods.values(),
			...this.services.values(),
			...this.endpointSlices.values(),
		];
	}

	objectByIdentity(
		apiVersion: string,
		kind: string,
		namespace: string,
		name: string,
	): ModeledObject | undefined {
		const key = `${namespace}/${name}`;
		if (apiVersion === "apps/v1" && kind === "Deployment") {
			return this.deployments.get(key);
		}
		if (apiVersion === "apps/v1" && kind === "ReplicaSet") {
			return this.replicaSets.get(key);
		}
		if (apiVersion === "v1" && kind === "Pod") {
			return this.pods.get(key);
		}
		if (apiVersion === "v1" && kind === "Service") {
			return this.services.get(key);
		}
		if (apiVersion === "discovery.k8s.io/v1" && kind === "EndpointSlice") {
			return this.endpointSlices.get(key);
		}
		return undefined;
	}

	cacheObject(object: ModeledObject): void {
		const identity = identityFor(object);
		if (!identity) {
			return;
		}
		const key = objectKey(object);
		if (identity.apiVersion === "apps/v1" && identity.kind === "Deployment") {
			this.deployments.set(key, object as k8s.V1Deployment);
		}
		if (identity.apiVersion === "apps/v1" && identity.kind === "ReplicaSet") {
			this.replicaSets.set(key, object as k8s.V1ReplicaSet);
		}
		if (identity.apiVersion === "v1" && identity.kind === "Pod") {
			this.pods.set(key, object as k8s.V1Pod);
		}
		if (identity.apiVersion === "v1" && identity.kind === "Service") {
			this.services.set(key, object as k8s.V1Service);
		}
		if (identity.apiVersion === "discovery.k8s.io/v1" && identity.kind === "EndpointSlice") {
			this.endpointSlices.set(key, object as k8s.V1EndpointSlice);
		}
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go runProcessGraphChanges.
	async runProcessGraphChanges(): Promise<void> {
		while (await this.processGraphChanges()) {}
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go processGraphChanges.
	async processGraphChanges(): Promise<boolean> {
		const [item, quit] = await this.graphChanges.get();
		if (quit) {
			return false;
		}
		if (!item) {
			return true;
		}
		try {
			const event = item;
			const obj = item.obj;
			const observedIdentity = identityFromEvent(event, obj);
			if (!observedIdentity) {
				return true;
			}

			let existingNode = this.uidToNode.get(observedIdentity.uid);
			const found = existingNode !== undefined;
			if (existingNode && !event.virtual && !existingNode.isObserved()) {
				if (!objectReferencesEqual(observedIdentity, existingNode.identity)) {
					const [, potentiallyInvalidDependents] = partitionDependents(
						existingNode.getDependents(),
						observedIdentity,
					);
					for (const dep of potentiallyInvalidDependents) {
						this.attemptToDelete.add(dep);
					}
					existingNode = existingNode.clone();
					existingNode.identity = observedIdentity;
					this.uidToNode.set(existingNode.identity.uid, existingNode);
				}
				existingNode.markObserved();
			}

			if ((event.eventType === "add" || event.eventType === "update") && !found) {
				const newNode = new Node(observedIdentity, obj);
				newNode.beingDeleted = beingDeleted(obj);
				newNode.deletingDependents = beingDeleted(obj) && hasDeleteDependentsFinalizer(obj);
				this.insertNode(newNode);
				this.processTransitions(event.oldObj, obj, newNode);
				return true;
			}

			if ((event.eventType === "add" || event.eventType === "update") && existingNode) {
				const [added, removed, changed] = referencesDiffs(
					existingNode.getOwners(),
					obj.metadata?.ownerReferences ?? [],
				);
				if (added.length > 0 || removed.length > 0 || changed.length > 0) {
					this.addUnblockedOwnersToDeleteQueue(removed, changed);
					existingNode.setOwners(obj.metadata?.ownerReferences ?? []);
					this.addDependentToOwners(existingNode, added);
					this.removeDependentFromOwners(existingNode, removed);
				}

				if (beingDeleted(obj)) {
					existingNode.markBeingDeleted();
				}
				this.processTransitions(event.oldObj, obj, existingNode);
				return true;
			}

			if (event.eventType === "delete") {
				if (!existingNode) {
					return true;
				}

				let removeExistingNode = true;
				if (event.virtual) {
					const deletedIdentity = observedIdentity;
					if (existingNode.virtual) {
						const [matchingDependents, nonmatchingDependents] = partitionDependents(
							existingNode.getDependents(),
							deletedIdentity,
						);
						if (nonmatchingDependents.length > 0) {
							removeExistingNode = false;
							if (matchingDependents.length > 0) {
								this.absentOwnerCache.add(deletedIdentity);
								for (const dep of matchingDependents) {
									this.attemptToDelete.add(dep);
								}
							}

							if (objectReferencesEqual(existingNode.identity, deletedIdentity)) {
								const replacementIdentity = getAlternateOwnerIdentity(
									nonmatchingDependents,
									deletedIdentity,
								);
								if (replacementIdentity) {
									const replacementNode = existingNode.clone();
									replacementNode.identity = replacementIdentity;
									this.uidToNode.set(replacementIdentity.uid, replacementNode);
									this.attemptToDelete.addRateLimited(replacementNode);
								}
							}
						}
					} else if (!objectReferencesEqual(existingNode.identity, deletedIdentity)) {
						removeExistingNode = false;
						const [matchingDependents] = partitionDependents(
							existingNode.getDependents(),
							deletedIdentity,
						);
						if (matchingDependents.length > 0) {
							this.absentOwnerCache.add(deletedIdentity);
							for (const dependent of matchingDependents) {
								this.attemptToDelete.add(dependent);
							}
						}
					}
				}

				if (removeExistingNode) {
					this.removeNode(existingNode);
					if (existingNode.dependentsLength() > 0) {
						this.absentOwnerCache.add(observedIdentity);
					}
					for (const dep of existingNode.getDependents()) {
						this.attemptToDelete.add(dep);
					}
					for (const owner of existingNode.getOwners()) {
						const ownerNode = this.uidToNode.get(owner.uid);
						if (ownerNode?.isDeletingDependents()) {
							this.attemptToDelete.add(ownerNode);
						}
					}
				}
			}
			return true;
		} finally {
			this.graphChanges.done(item);
		}
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go addDependentToOwners.
	private addDependentToOwners(node: Node, owners: k8s.V1OwnerReference[]): void {
		let hasPotentiallyInvalidOwnerReference = false;
		for (const owner of owners) {
			let ownerNode = this.uidToNode.get(owner.uid);
			const ok = ownerNode !== undefined;
			if (!ownerNode) {
				ownerNode = new Node({
					...ownerReferenceCoordinates(owner),
					namespace: node.identity.namespace,
				});
				this.uidToNode.set(owner.uid, ownerNode);
			}
			ownerNode.addDependent(node);
			if (!ok) {
				this.attemptToDelete.add(ownerNode);
			} else if (!hasPotentiallyInvalidOwnerReference) {
				const ownerIsNamespaced = ownerNode.identity.namespace.length > 0;
				if (ownerIsNamespaced && ownerNode.identity.namespace !== node.identity.namespace) {
					hasPotentiallyInvalidOwnerReference = true;
				} else if (!ownerReferenceMatchesCoordinates(owner, ownerNode.identity)) {
					hasPotentiallyInvalidOwnerReference = true;
				} else if (
					!ownerIsNamespaced &&
					ownerNode.identity.namespace !== node.identity.namespace &&
					!ownerNode.isObserved()
				) {
					hasPotentiallyInvalidOwnerReference = true;
				}
			}
		}
		if (hasPotentiallyInvalidOwnerReference) {
			this.attemptToDelete.add(node);
		}
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go insertNode.
	private insertNode(node: Node): void {
		this.uidToNode.set(node.identity.uid, node);
		this.addDependentToOwners(node, node.getOwners());
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go removeDependentFromOwners.
	private removeDependentFromOwners(node: Node, owners: k8s.V1OwnerReference[]): void {
		for (const owner of owners) {
			const ownerNode = this.uidToNode.get(owner.uid);
			ownerNode?.deleteDependent(node);
		}
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go removeNode.
	private removeNode(node: Node): void {
		this.uidToNode.delete(node.identity.uid);
		this.removeDependentFromOwners(node, node.getOwners());
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go addUnblockedOwnersToDeleteQueue.
	private addUnblockedOwnersToDeleteQueue(
		removed: k8s.V1OwnerReference[],
		changed: OwnerRefPair[],
	): void {
		for (const ref of removed) {
			if (ref.blockOwnerDeletion === true) {
				const node = this.uidToNode.get(ref.uid);
				if (node) {
					this.attemptToDelete.add(node);
				}
			}
		}
		for (const change of changed) {
			const wasBlocked = change.oldRef.blockOwnerDeletion === true;
			const isUnblocked = change.newRef.blockOwnerDeletion !== true;
			if (wasBlocked && isUnblocked) {
				const node = this.uidToNode.get(change.newRef.uid);
				if (node) {
					this.attemptToDelete.add(node);
				}
			}
		}
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go processTransitions.
	private processTransitions(
		oldObj: ModeledObject | undefined,
		newObj: ModeledObject,
		n: Node,
	): void {
		if (startsWaitingForDependentsOrphaned(oldObj, newObj)) {
			this.attemptToOrphan.add(n);
			return;
		}
		if (startsWaitingForDependentsDeleted(oldObj, newObj)) {
			n.markDeletingDependents();
			for (const dep of n.getDependents()) {
				this.attemptToDelete.add(dep);
			}
			this.attemptToDelete.add(n);
		}
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go enqueueVirtualDeleteEvent.
	enqueueVirtualDeleteEvent(ref: ObjectReference): void {
		this.graphChanges.add({
			eventType: "delete",
			virtual: true,
			obj: {
				apiVersion: ref.apiVersion,
				kind: ref.kind,
				metadata: {
					name: ref.name,
					namespace: ref.namespace,
					uid: ref.uid,
				},
			},
		});
	}

	// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go GetGraphResources.
	getGraphResources(): [
		TypedRateLimitingInterface<Node>,
		TypedRateLimitingInterface<Node>,
		ReferenceCache,
	] {
		return [this.attemptToDelete, this.attemptToOrphan, this.absentOwnerCache];
	}
}

// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go NewDependencyGraphBuilder.
export function newDependencyGraphBuilder(
	api: k8s.KubeClient,
	kubeConfig: k8s.KubeConfig,
): GraphBuilder {
	return new GraphBuilder(api, kubeConfig);
}

// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go identityFromEvent.
function identityFromEvent(_event: GraphEvent, object: ModeledObject): ObjectReference | undefined {
	const apiVersion = object.apiVersion;
	const kind = object.kind;
	const name = object.metadata?.name;
	const uid = object.metadata?.uid;
	if (!apiVersion || !kind || !name || !uid) {
		return undefined;
	}
	return {
		apiVersion,
		kind,
		name,
		namespace: object.metadata?.namespace ?? "default",
		uid,
	};
}

// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go partitionDependents.
export function partitionDependents(
	dependents: Node[],
	matchOwnerIdentity: ObjectReference,
): [matching: Node[], nonmatching: Node[]] {
	const matching: Node[] = [];
	const nonmatching: Node[] = [];
	const ownerIsNamespaced = matchOwnerIdentity.namespace.length > 0;
	for (const dep of dependents) {
		let foundMatch = false;
		let foundMismatch = false;
		if (ownerIsNamespaced && matchOwnerIdentity.namespace !== dep.identity.namespace) {
			foundMismatch = true;
		} else {
			for (const ownerRef of dep.getOwners()) {
				if (ownerRef.uid === matchOwnerIdentity.uid) {
					if (ownerReferenceMatchesCoordinates(ownerRef, matchOwnerIdentity)) {
						foundMatch = true;
					} else {
						foundMismatch = true;
					}
				}
			}
		}
		if (foundMatch) {
			matching.push(dep);
		}
		if (foundMismatch) {
			nonmatching.push(dep);
		}
	}
	return [matching, nonmatching];
}

// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go referencesDiffs.
export function referencesDiffs(
	oldRefs: k8s.V1OwnerReference[],
	newRefs: k8s.V1OwnerReference[],
): [added: k8s.V1OwnerReference[], removed: k8s.V1OwnerReference[], changed: OwnerRefPair[]] {
	const oldUIDToRef = new Map<string, k8s.V1OwnerReference>();
	for (const value of oldRefs) {
		oldUIDToRef.set(value.uid, value);
	}
	const oldUIDSet = new Set(oldUIDToRef.keys());
	const added: k8s.V1OwnerReference[] = [];
	const changed: OwnerRefPair[] = [];
	for (const value of newRefs) {
		const oldValue = oldUIDToRef.get(value.uid);
		if (oldValue) {
			if (!deepEqual(oldValue, value)) {
				changed.push({ oldRef: oldValue, newRef: value });
			}
			oldUIDSet.delete(value.uid);
		} else {
			added.push(value);
		}
	}

	const removed: k8s.V1OwnerReference[] = [];
	for (const oldUID of oldUIDSet) {
		const oldValue = oldUIDToRef.get(oldUID);
		if (oldValue) {
			removed.push(oldValue);
		}
	}
	return [added, removed, changed];
}

// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go deletionStartsWithFinalizer.
function deletionStartsWithFinalizer(
	oldObj: ModeledObject | undefined,
	newObj: ModeledObject,
	matchingFinalizer: string,
): boolean {
	if (!beingDeleted(newObj) || !hasFinalizer(newObj, matchingFinalizer)) {
		return false;
	}
	if (!oldObj) {
		return true;
	}
	return !beingDeleted(oldObj) || !hasFinalizer(oldObj, matchingFinalizer);
}

// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go beingDeleted.
function beingDeleted(object: ModeledObject): boolean {
	return object.metadata?.deletionTimestamp !== undefined;
}

// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go hasFinalizer.
function hasFinalizer(object: ModeledObject, matchingFinalizer: string): boolean {
	return (object.metadata?.finalizers ?? []).includes(matchingFinalizer);
}

// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go startsWaitingForDependentsDeleted.
function startsWaitingForDependentsDeleted(
	oldObj: ModeledObject | undefined,
	newObj: ModeledObject,
): boolean {
	return deletionStartsWithFinalizer(oldObj, newObj, finalizerDeleteDependents);
}

// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go startsWaitingForDependentsOrphaned.
function startsWaitingForDependentsOrphaned(
	oldObj: ModeledObject | undefined,
	newObj: ModeledObject,
): boolean {
	return deletionStartsWithFinalizer(oldObj, newObj, finalizerOrphanDependents);
}

// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go referenceLessThan.
export function referenceLessThan(a: ObjectReference, b: ObjectReference): boolean {
	if (a.kind !== b.kind) {
		return a.kind < b.kind;
	}
	if (a.apiVersion !== b.apiVersion) {
		return a.apiVersion < b.apiVersion;
	}
	if (a.namespace !== b.namespace) {
		return a.namespace < b.namespace;
	}
	if (a.name !== b.name) {
		return a.name < b.name;
	}
	if (a.uid !== b.uid) {
		return a.uid < b.uid;
	}
	return false;
}

// Models kubernetes/pkg/controller/garbagecollector/graph_builder.go getAlternateOwnerIdentity.
export function getAlternateOwnerIdentity(
	deps: Node[],
	verifiedAbsentIdentity: ObjectReference,
): ObjectReference | undefined {
	const absentIdentityIsClusterScoped = verifiedAbsentIdentity.namespace.length === 0;
	const seenAlternates = new Set<string>([objectReferenceKey(verifiedAbsentIdentity)]);
	let first: ObjectReference | undefined;
	let firstFollowing: ObjectReference | undefined;

	for (const dep of deps) {
		for (const ownerRef of dep.getOwners()) {
			if (ownerRef.uid !== verifiedAbsentIdentity.uid) {
				continue;
			}
			if (ownerReferenceMatchesCoordinates(ownerRef, verifiedAbsentIdentity)) {
				if (
					absentIdentityIsClusterScoped ||
					verifiedAbsentIdentity.namespace === dep.identity.namespace
				) {
					continue;
				}
			}

			const coordinates = ownerReferenceCoordinates(ownerRef);
			const ref: ObjectReference = {
				apiVersion: coordinates.apiVersion,
				kind: coordinates.kind,
				name: coordinates.name,
				namespace: dep.identity.namespace,
				uid: coordinates.uid,
			};
			if (
				absentIdentityIsClusterScoped &&
				ref.apiVersion === verifiedAbsentIdentity.apiVersion &&
				ref.kind === verifiedAbsentIdentity.kind
			) {
				ref.namespace = "";
			}

			const key = objectReferenceKey(ref);
			if (seenAlternates.has(key)) {
				continue;
			}
			seenAlternates.add(key);

			if (!first || referenceLessThan(ref, first)) {
				first = ref;
			}
			if (
				referenceLessThan(verifiedAbsentIdentity, ref) &&
				(!firstFollowing || referenceLessThan(ref, firstFollowing))
			) {
				firstFollowing = ref;
			}
		}
	}

	return firstFollowing ?? first;
}

function objectReferenceKey(reference: ObjectReference): string {
	return [
		reference.apiVersion,
		reference.kind,
		reference.namespace,
		reference.name,
		reference.uid,
	].join("\0");
}

function objectReferencesEqual(left: ObjectReference, right: ObjectReference): boolean {
	return (
		left.apiVersion === right.apiVersion &&
		left.kind === right.kind &&
		left.namespace === right.namespace &&
		left.name === right.name &&
		left.uid === right.uid
	);
}

function objectKey(object: k8s.KubernetesObject): string {
	return `${object.metadata?.namespace ?? "default"}/${object.metadata?.name ?? ""}`;
}
