/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import * as k8s from "../../client";
import {
	isConflictError,
	isNotFoundError,
	isUnsupportedMediaTypeError,
	UnsupportedMediaType,
} from "../../client/errors";
import {
	finalizerDeleteDependents,
	finalizerOrphanDependents,
	type DeletePropagationPolicy,
} from "../../client/gen/apis/impls/delete";
import type { TypedRateLimitingInterface } from "../../client-go/util/workqueue/rate-limiting-queue";
import { GraphBuilder, newDependencyGraphBuilder } from "./graph-builder";
import {
	hasDeleteDependentsFinalizer,
	hasOrphanFinalizer,
	identityFor,
	Node,
	type ModeledObject,
	type ObjectReference,
} from "./graph";
import type { ReferenceCache } from "./uid-cache";
import { retryConflicts } from "../../retry";
import type * as context from "../../go/context";
import { generateDeleteOwnerRefStrategicMergeBytes } from "../controller-ref-manager";
import { deepEqual } from "../../deep-equal";
import { Channel } from "../../go/channel";
import { WaitGroup } from "../../go/sync/wait-group";
import { newAggregate } from "../../apimachinery/pkg/util/errors/errors";
import { getClock } from "../../clock-context";

type WorkQueueItemAction = "forgetItem" | "requeueItem";
type MarshalResult = [Uint8Array | undefined, Error | undefined];
type JsonMergePatchFunc = (n: Node) => Promise<MarshalResult>;

// Models kubernetes/pkg/controller/garbagecollector/patch.go ObjectMetaForPatch.
interface ObjectMetaForPatch {
	resourceVersion: string | undefined;
	ownerReferences: k8s.V1OwnerReference[];
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go enqueuedVirtualDeleteEventErr.
export const enqueuedVirtualDeleteEventErr = new Error("enqueued virtual delete event");

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go namespacedOwnerOfClusterScopedObjectErr.
export const namespacedOwnerOfClusterScopedObjectErr = new Error(
	"cluster-scoped objects cannot refer to namespaced owners",
);

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go GarbageCollector.
export class GarbageCollector {
	readonly dependencyGraphBuilder: GraphBuilder;
	attemptToDelete: TypedRateLimitingInterface<Node>;
	attemptToOrphan: TypedRateLimitingInterface<Node>;
	absentOwnerCache: ReferenceCache;
	private attemptToDeleteWorkerPromise: Promise<void> | undefined;
	private attemptToOrphanWorkerPromise: Promise<void> | undefined;

	constructor(
		private readonly api: k8s.KubeClient,
		kubeConfig: k8s.KubeConfig,
		graphBuilder: GraphBuilder = newDependencyGraphBuilder(api, kubeConfig),
	) {
		this.dependencyGraphBuilder = graphBuilder;
		[this.attemptToDelete, this.attemptToOrphan, this.absentOwnerCache] =
			this.dependencyGraphBuilder.getGraphResources();
	}

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go Run.
	async run(ctx: context.Context): Promise<void> {
		await this.dependencyGraphBuilder.run(ctx);
		await this.processObjectsWithoutFinalizers(ctx);
		this.attemptToDeleteWorkerPromise = this.runAttemptToDeleteWorker(ctx);
		this.attemptToOrphanWorkerPromise = this.runAttemptToOrphanWorker(ctx);
	}

	async stop(): Promise<void> {
		await this.dependencyGraphBuilder.stop();
		await this.attemptToDeleteWorkerPromise;
		await this.attemptToOrphanWorkerPromise;
	}

	async processObjectsWithoutFinalizers(ctx: context.Context): Promise<void> {
		for (const object of this.dependencyGraphBuilder.objects()) {
			if (
				object.metadata?.deletionTimestamp &&
				(object.metadata.finalizers ?? []).length === 0 &&
				(object.kind !== "Pod" || (object.metadata.deletionGracePeriodSeconds ?? 0) <= 0)
			) {
				await this.deleteObject(ctx, identityFor(object), "", [], "Background");
			}
		}
	}

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go runAttemptToDeleteWorker.
	async runAttemptToDeleteWorker(ctx: context.Context): Promise<void> {
		while (await this.processAttemptToDeleteWorker(ctx)) {}
	}

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go processAttemptToDeleteWorker.
	async processAttemptToDeleteWorker(ctx: context.Context): Promise<boolean> {
		const [item, quit] = await this.attemptToDelete.get();
		if (quit) {
			return false;
		}
		if (!item) {
			return true;
		}
		const action = await this.attemptToDeleteWorker(ctx, item);
		switch (action) {
			case "forgetItem":
				this.attemptToDelete.forget(item);
				break;
			case "requeueItem":
				await this.attemptToDelete.addRateLimited(item);
				break;
		}
		this.attemptToDelete.done(item);
		return true;
	}

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go attemptToDeleteWorker.
	async attemptToDeleteWorker(ctx: context.Context, n: Node): Promise<WorkQueueItemAction> {
		if (!n.isObserved()) {
			const nodeFromGraph = this.dependencyGraphBuilder.uidToNode.get(n.identity.uid);
			if (!nodeFromGraph) {
				return "forgetItem";
			}
			if (nodeFromGraph.isObserved()) {
				return "forgetItem";
			}
		}
		try {
			const err = await this.attemptToDeleteItem(ctx, n);
			if (err === enqueuedVirtualDeleteEventErr) {
				return "forgetItem";
			}
			if (err === namespacedOwnerOfClusterScopedObjectErr) {
				return "forgetItem";
			}
			if (err) {
				return "requeueItem";
			}
			if (!n.isObserved()) {
				return "requeueItem";
			}
			return "forgetItem";
		} catch (error) {
			if (isNotFoundError(error)) {
				return "forgetItem";
			}
			return "requeueItem";
		}
	}

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go attemptToDeleteItem.
	async attemptToDeleteItem(ctx: context.Context, item: Node): Promise<Error | undefined> {
		if (item.isBeingDeleted() && !item.isDeletingDependents()) {
			return undefined;
		}
		const [latest, getErr] = await this.getObject(item.identity);
		if (isNotFoundError(getErr)) {
			this.dependencyGraphBuilder.enqueueVirtualDeleteEvent(item.identity);
			return enqueuedVirtualDeleteEventErr;
		}
		if (getErr) {
			return getErr;
		}
		if (!latest || latest.metadata?.uid !== item.identity.uid) {
			this.dependencyGraphBuilder.enqueueVirtualDeleteEvent(item.identity);
			return enqueuedVirtualDeleteEventErr;
		}

		if (item.isDeletingDependents()) {
			return await this.processDeletingDependentsItem(ctx, item);
		}

		const ownerReferences = latest.metadata?.ownerReferences ?? [];
		if (ownerReferences.length === 0) {
			return undefined;
		}

		const [solid, dangling, waitingForDependentsDeletion, classifyErr] =
			await this.classifyReferences(ctx, item, ownerReferences);
		if (classifyErr) {
			return classifyErr;
		}
		if (solid.length > 0) {
			if (dangling.length === 0 && waitingForDependentsDeletion.length === 0) {
				return undefined;
			}
			const ownerUIDs = [
				...ownerRefsToUIDs(dangling),
				...ownerRefsToUIDs(waitingForDependentsDeletion),
			];
			const [p, err] = generateDeleteOwnerRefStrategicMergeBytes(item.identity.uid, ownerUIDs);
			if (err) {
				return err;
			}
			if (!p) {
				return new Error("GenerateDeleteOwnerRefStrategicMergeBytes returned no patch");
			}
			const [, patchErr] = await this.patch(
				ctx,
				item,
				p,
				async (n) => await this.deleteOwnerRefJSONMergePatch(n, ...ownerUIDs),
			);
			return patchErr;
		}
		if (waitingForDependentsDeletion.length > 0 && item.dependentsLength() > 0) {
			for (const dependent of item.getDependents()) {
				if (dependent.isDeletingDependents()) {
					// TODO(samwho): upstream uses this.patch here after generating a
					// strategic merge patch to unblock owner references, we should
					// eventually do the same.
					const err = await errorFrom(async () => {
						await this.unblockOwnerReferences(ctx, latest);
					});
					if (err) {
						return err;
					}
					break;
				}
			}
			const err = await this.deleteObject(
				ctx,
				item.identity,
				latest.metadata?.resourceVersion ?? "",
				latest.metadata?.ownerReferences ?? [],
				"Foreground",
			);
			if (isNotFoundError(err)) {
				this.dependencyGraphBuilder.enqueueVirtualDeleteEvent(item.identity);
				return enqueuedVirtualDeleteEventErr;
			}
			return err;
		}

		const propagationPolicy = hasOrphanFinalizer(latest)
			? "Orphan"
			: hasDeleteDependentsFinalizer(latest)
				? "Foreground"
				: "Background";
		const err = await this.deleteObject(
			ctx,
			item.identity,
			latest.metadata?.resourceVersion ?? "",
			latest.metadata?.ownerReferences ?? [],
			propagationPolicy,
		);
		if (isNotFoundError(err)) {
			this.dependencyGraphBuilder.enqueueVirtualDeleteEvent(item.identity);
			return enqueuedVirtualDeleteEventErr;
		}
		return err;
	}

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go classifyReferences.
	async classifyReferences(
		ctx: context.Context,
		item: Node,
		latestReferences: k8s.V1OwnerReference[],
	): Promise<
		[
			solid: k8s.V1OwnerReference[],
			dangling: k8s.V1OwnerReference[],
			waitingForDependentsDeletion: k8s.V1OwnerReference[],
			err: Error | undefined,
		]
	> {
		const solid: k8s.V1OwnerReference[] = [];
		const dangling: k8s.V1OwnerReference[] = [];
		const waitingForDependentsDeletion: k8s.V1OwnerReference[] = [];
		for (const reference of latestReferences) {
			const [isDangling, owner, err] = await this.isDangling(ctx, reference, item);
			if (err) {
				return [solid, dangling, waitingForDependentsDeletion, err];
			}
			if (isDangling) {
				dangling.push(reference);
				continue;
			}
			if (owner?.metadata?.deletionTimestamp && hasDeleteDependentsFinalizer(owner)) {
				waitingForDependentsDeletion.push(reference);
			} else {
				solid.push(reference);
			}
		}
		return [solid, dangling, waitingForDependentsDeletion, undefined];
	}

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go isDangling.
	async isDangling(
		_ctx: context.Context,
		reference: k8s.V1OwnerReference,
		item: Node,
	): Promise<[isDangling: boolean, owner: ModeledObject | undefined, err: Error | undefined]> {
		const absentOwnerCacheKey: ObjectReference = {
			apiVersion: reference.apiVersion,
			kind: reference.kind,
			name: reference.name,
			namespace: "",
			uid: reference.uid,
		};
		if (this.absentOwnerCache.has(absentOwnerCacheKey)) {
			return [true, undefined, undefined];
		}
		absentOwnerCacheKey.namespace = item.identity.namespace;
		if (this.absentOwnerCache.has(absentOwnerCacheKey)) {
			return [true, undefined, undefined];
		}

		const namespaced = resourceIsNamespaced(reference);
		if (!namespaced) {
			absentOwnerCacheKey.namespace = "";
		}
		if (item.identity.namespace.length === 0 && namespaced) {
			return [false, undefined, namespacedOwnerOfClusterScopedObjectErr];
		}
		const [owner, err] = await this.getObject(absentOwnerCacheKey);
		if (isNotFoundError(err)) {
			this.absentOwnerCache.add(absentOwnerCacheKey);
			return [true, undefined, undefined];
		}
		if (err) {
			return [false, undefined, err];
		}

		if (owner?.metadata?.uid !== reference.uid) {
			this.absentOwnerCache.add(absentOwnerCacheKey);
			return [true, undefined, undefined];
		}
		return [false, owner, undefined];
	}

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go processDeletingDependentsItem.
	async processDeletingDependentsItem(
		ctx: context.Context,
		item: Node,
	): Promise<Error | undefined> {
		const blockingDependents = item.blockingDependents();
		if (blockingDependents.length === 0) {
			return await errorFrom(async () => {
				await this.removeFinalizer(ctx, item, finalizerDeleteDependents);
			});
		}
		for (const dependent of blockingDependents) {
			if (!dependent.isDeletingDependents()) {
				this.attemptToDelete.add(dependent);
			}
		}
		return undefined;
	}

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go runAttemptToOrphanWorker.
	async runAttemptToOrphanWorker(ctx: context.Context): Promise<void> {
		while (await this.processAttemptToOrphanWorker(ctx)) {}
	}

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go processAttemptToOrphanWorker.
	async processAttemptToOrphanWorker(ctx: context.Context): Promise<boolean> {
		const [item, quit] = await this.attemptToOrphan.get();
		if (quit) {
			return false;
		}
		if (!item) {
			return true;
		}
		const action = await this.attemptToOrphanWorker(ctx, item);
		switch (action) {
			case "forgetItem":
				this.attemptToOrphan.forget(item);
				break;
			case "requeueItem":
				void this.attemptToOrphan.addRateLimited(item);
				break;
		}
		this.attemptToOrphan.done(item);
		return true;
	}

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go attemptToOrphanWorker.
	async attemptToOrphanWorker(ctx: context.Context, owner: Node): Promise<WorkQueueItemAction> {
		const dependents = owner.getDependents();
		const err = await this.orphanDependents(ctx, owner.identity, dependents);
		if (err) {
			return "requeueItem";
		}
		try {
			await this.removeFinalizer(ctx, owner, finalizerOrphanDependents);
			const err = await this.deleteObject(ctx, owner.identity, "", [], "Background");
			if (err) {
				return "requeueItem";
			}
			return "forgetItem";
		} catch {
			return "requeueItem";
		}
	}

	// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go orphanDependents.
	async orphanDependents(
		ctx: context.Context,
		owner: ObjectReference,
		dependents: Node[],
	): Promise<Error | undefined> {
		const clock = getClock(ctx);
		const errCh = new Channel<Error>(dependents.length);
		const wg = new WaitGroup();
		wg.add(dependents.length);
		for (const dependent of dependents) {
			clock.queueMicrotask(() => {
				void (async () => {
					try {
						const [p, err] = generateDeleteOwnerRefStrategicMergeBytes(dependent.identity.uid, [
							owner.uid,
						]);
						if (err) {
							await errCh.send(new Error(`orphaning ${dependent.identity} failed, ${err.message}`));
							return;
						}
						if (!p) {
							await errCh.send(
								new Error(
									`orphaning ${dependent.identity} failed, GenerateDeleteOwnerRefStrategicMergeBytes returned no patch`,
								),
							);
							return;
						}
						const [, patchErr] = await this.patch(
							ctx,
							dependent,
							p,
							async (n) => await this.deleteOwnerRefJSONMergePatch(n, owner.uid),
						);
						if (patchErr && !isNotFoundError(patchErr)) {
							await errCh.send(
								new Error(`orphaning ${dependent.identity} failed, ${patchErr.message}`),
							);
						}
					} finally {
						wg.done();
					}
				})();
			});
		}
		await wg.wait();
		errCh.close();

		const errorsSlice: Error[] = [];
		for await (const result of errCh) {
			errorsSlice.push(result);
		}

		if (errorsSlice.length !== 0) {
			return new Error(
				`failed to orphan dependents of owner ${owner}, got errors: ${newAggregate(errorsSlice)?.message ?? ""}`,
			);
		}
		return undefined;
	}

	// Models kubernetes/pkg/controller/garbagecollector/operations.go getObject.
	async getObject(item: ObjectReference): Promise<[ModeledObject | undefined, Error | undefined]> {
		try {
			if (resourceIsNamespaced(item) && item.namespace.length === 0) {
				return [undefined, namespacedOwnerOfClusterScopedObjectErr];
			}
			if (item.apiVersion === "apps/v1" && item.kind === "Deployment") {
				return [await this.api.appsv1.readNamespacedDeployment(item), undefined];
			}
			if (item.apiVersion === "apps/v1" && item.kind === "ReplicaSet") {
				return [await this.api.appsv1.readNamespacedReplicaSet(item), undefined];
			}
			if (item.apiVersion === "v1" && item.kind === "Node") {
				return [await this.api.corev1.readNode({ name: item.name }), undefined];
			}
			if (item.apiVersion === "v1" && item.kind === "Pod") {
				return [await this.api.corev1.readNamespacedPod(item), undefined];
			}
			if (item.apiVersion === "v1" && item.kind === "Service") {
				return [await this.api.corev1.readNamespacedService(item), undefined];
			}
			if (item.apiVersion === "discovery.k8s.io/v1" && item.kind === "EndpointSlice") {
				return [await this.api.discoveryv1.readNamespacedEndpointSlice(item), undefined];
			}
		} catch (error) {
			return [undefined, errorAsError(error)];
		}
		throw new Error(`unsupported object resource ${item.apiVersion}/${item.kind}`);
	}

	// Models kubernetes/pkg/controller/garbagecollector/operations.go removeFinalizer.
	async removeFinalizer(ctx: context.Context, owner: Node, finalizer: string): Promise<void> {
		const [object, err] = await this.getObject(owner.identity);
		if (isNotFoundError(err)) {
			return;
		}
		if (err) {
			throw err;
		}
		if (!object) {
			return;
		}
		await this.updateObject(ctx, object, (latest) => {
			latest.metadata ??= {};
			const finalizers = (latest.metadata.finalizers ?? []).filter((value) => value !== finalizer);
			latest.metadata.finalizers = finalizers.length > 0 ? finalizers : undefined;
		});
	}

	// Models kubernetes/pkg/controller/garbagecollector/patch.go patch.
	async patch(
		ctx: context.Context,
		item: Node,
		smp: Uint8Array,
		jmp: JsonMergePatchFunc,
	): Promise<[ModeledObject | undefined, Error | undefined]> {
		const [smpResult, smpErr] = await this.patchObject(
			ctx,
			item.identity,
			smp,
			k8s.PatchStrategy.StrategicMergePatch,
		);
		if (!smpErr) {
			return [smpResult, undefined];
		}
		if (!isUnsupportedMediaTypeError(smpErr)) {
			return [undefined, smpErr];
		}
		const [patch, patchErr] = await jmp(item);
		if (patchErr || !patch) {
			return [undefined, patchErr];
		}
		return await this.patchObject(ctx, item.identity, patch, k8s.PatchStrategy.MergePatch);
	}

	// Models kubernetes/pkg/controller/garbagecollector/patch.go deleteOwnerRefJSONMergePatch.
	async deleteOwnerRefJSONMergePatch(
		item: Node,
		...ownerUIDs: string[]
	): Promise<[Uint8Array | undefined, Error | undefined]> {
		const [accessor, err] = await this.getMetadata(
			item.identity.apiVersion,
			item.identity.kind,
			item.identity.namespace,
			item.identity.name,
		);
		if (err || !accessor) {
			return [undefined, err];
		}
		const expectedObjectMeta: ObjectMetaForPatch = {
			resourceVersion: accessor.metadata?.resourceVersion,
			ownerReferences: [],
		};
		const refs = accessor.metadata?.ownerReferences ?? [];
		for (const ref of refs) {
			if (!ownerUIDs.includes(ref.uid ?? "")) {
				expectedObjectMeta.ownerReferences.push(ref);
			}
		}
		return jsonMarshal({ metadata: expectedObjectMeta });
	}

	// Models kubernetes/pkg/controller/garbagecollector/patch.go getMetadata.
	async getMetadata(
		apiVersion: string,
		kind: string,
		namespace: string,
		name: string,
	): Promise<[ModeledObject | undefined, Error | undefined]> {
		const cached = this.dependencyGraphBuilder.objectByIdentity(apiVersion, kind, namespace, name);
		if (cached) {
			return [cached, undefined];
		}
		return await this.getObject({
			apiVersion,
			kind,
			namespace,
			name,
			uid: "",
		});
	}

	// Models kubernetes/pkg/controller/garbagecollector/operations.go patchObject.
	// TODO(samwho): centralise this with other dynamic object modification code
	// in future.
	async patchObject(
		ctx: context.Context,
		identity: ObjectReference,
		data: Uint8Array,
		patchType: k8s.PatchStrategy,
	): Promise<[ModeledObject | undefined, Error | undefined]> {
		try {
			const body = decodePatch(data);
			const options = k8s.setHeaderOptions("Content-Type", patchType);
			if (identity.apiVersion === "apps/v1" && identity.kind === "Deployment") {
				const deployment = await this.api.appsv1.patchNamespacedDeployment(
					{
						name: identity.name,
						namespace: identity.namespace,
						body,
					},
					options,
				);
				this.dependencyGraphBuilder.cacheObject(deployment);
				return [deployment, undefined];
			}
			if (identity.apiVersion === "apps/v1" && identity.kind === "ReplicaSet") {
				const replicaSet = await this.api.appsv1.patchNamespacedReplicaSet(
					{
						name: identity.name,
						namespace: identity.namespace,
						body,
					},
					options,
				);
				this.dependencyGraphBuilder.cacheObject(replicaSet);
				return [replicaSet, undefined];
			}
			if (identity.apiVersion === "v1" && identity.kind === "Node") {
				const node = await this.api.corev1.patchNode(
					{
						name: identity.name,
						body,
					},
					options,
				);
				this.dependencyGraphBuilder.cacheObject(node);
				return [node, undefined];
			}
			if (identity.apiVersion === "v1" && identity.kind === "Pod") {
				const pod = await this.api.corev1.patchNamespacedPod(
					{
						name: identity.name,
						namespace: identity.namespace,
						body,
					},
					options,
				);
				this.dependencyGraphBuilder.cacheObject(pod);
				return [pod, undefined];
			}
			if (identity.apiVersion === "v1" && identity.kind === "Service") {
				const service = await this.api.corev1.patchNamespacedService(
					{
						name: identity.name,
						namespace: identity.namespace,
						body,
					},
					options,
				);
				this.dependencyGraphBuilder.cacheObject(service);
				return [service, undefined];
			}
			if (identity.apiVersion === "discovery.k8s.io/v1" && identity.kind === "EndpointSlice") {
				if (patchType === k8s.PatchStrategy.StrategicMergePatch) {
					return [undefined, new UnsupportedMediaType(`Unsupported Media Type: ${patchType}`)];
				}
				const [patched, err] = await this.patchEndpointSlice(ctx, identity, body);
				if (patched) {
					this.dependencyGraphBuilder.cacheObject(patched);
				}
				return [patched, err];
			}
			return [undefined, unsupportedObjectResourceError(identity)];
		} catch (error) {
			return [undefined, errorAsError(error)];
		}
	}

	async patchEndpointSlice(
		ctx: context.Context,
		identity: ObjectReference,
		body: Record<string, unknown>,
	): Promise<[k8s.V1EndpointSlice | undefined, Error | undefined]> {
		try {
			let patched: k8s.V1EndpointSlice | undefined;
			await retryConflicts(ctx, async () => {
				const latest = await this.api.discoveryv1.readNamespacedEndpointSlice(identity);
				const metadata = body.metadata;
				if (isRecord(metadata) && Array.isArray(metadata.ownerReferences)) {
					latest.metadata ??= {};
					latest.metadata.ownerReferences = metadata.ownerReferences as k8s.V1OwnerReference[];
				}
				patched = await this.api.discoveryv1.replaceNamespacedEndpointSlice({
					name: identity.name,
					namespace: identity.namespace,
					body: latest,
				});
			});
			return [patched, undefined];
		} catch (error) {
			return [undefined, errorAsError(error)];
		}
	}

	// Models kubernetes/pkg/controller/garbagecollector/patch.go unblockOwnerReferencesStrategicMergePatch.
	async unblockOwnerReferences(ctx: context.Context, object: ModeledObject): Promise<void> {
		await this.updateObject(ctx, object, (latest) => {
			latest.metadata ??= {};
			latest.metadata.ownerReferences = (latest.metadata.ownerReferences ?? []).map((reference) =>
				reference.blockOwnerDeletion === true
					? { ...reference, blockOwnerDeletion: false }
					: reference,
			);
		});
	}

	async updateObject(
		ctx: context.Context,
		object: ModeledObject,
		mutate: (latest: ModeledObject) => void,
	): Promise<void> {
		const identity = identityFor(object);
		if (!identity) {
			return;
		}
		try {
			await retryConflicts(ctx, async () => {
				if (identity.apiVersion === "apps/v1" && identity.kind === "Deployment") {
					const latest = await this.api.appsv1.readNamespacedDeployment(identity);
					mutate(latest);
					this.dependencyGraphBuilder.cacheObject(
						await this.api.appsv1.replaceNamespacedDeployment({
							name: identity.name,
							namespace: identity.namespace,
							body: latest,
						}),
					);
					return;
				}
				if (identity.apiVersion === "apps/v1" && identity.kind === "ReplicaSet") {
					const latest = await this.api.appsv1.readNamespacedReplicaSet(identity);
					mutate(latest);
					this.dependencyGraphBuilder.cacheObject(
						await this.api.appsv1.replaceNamespacedReplicaSet({
							name: identity.name,
							namespace: identity.namespace,
							body: latest,
						}),
					);
					return;
				}
				if (identity.apiVersion === "v1" && identity.kind === "Node") {
					const latest = await this.api.corev1.readNode({ name: identity.name });
					mutate(latest);
					this.dependencyGraphBuilder.cacheObject(
						await this.api.corev1.replaceNode({
							name: identity.name,
							body: latest,
						}),
					);
					return;
				}
				if (identity.apiVersion === "v1" && identity.kind === "Pod") {
					const latest = await this.api.corev1.readNamespacedPod(identity);
					mutate(latest);
					this.dependencyGraphBuilder.cacheObject(
						await this.api.corev1.replaceNamespacedPod({
							name: identity.name,
							namespace: identity.namespace,
							body: latest,
						}),
					);
					return;
				}
				if (identity.apiVersion === "v1" && identity.kind === "Service") {
					const latest = await this.api.corev1.readNamespacedService(identity);
					mutate(latest);
					this.dependencyGraphBuilder.cacheObject(
						await this.api.corev1.replaceNamespacedService({
							name: identity.name,
							namespace: identity.namespace,
							body: latest,
						}),
					);
					return;
				}
				if (identity.apiVersion === "discovery.k8s.io/v1" && identity.kind === "EndpointSlice") {
					const latest = await this.api.discoveryv1.readNamespacedEndpointSlice(identity);
					mutate(latest);
					this.dependencyGraphBuilder.cacheObject(
						await this.api.discoveryv1.replaceNamespacedEndpointSlice({
							name: identity.name,
							namespace: identity.namespace,
							body: latest,
						}),
					);
					return;
				}
				throw unsupportedObjectResourceError(identity);
			});
		} catch (error) {
			if (!isNotFoundError(error)) {
				throw error;
			}
		}
	}

	async deleteObject(
		ctx: context.Context,
		identity: ObjectReference | undefined,
		resourceVersion: string,
		ownersAtResourceVersion: k8s.V1OwnerReference[],
		propagationPolicy: DeletePropagationPolicy,
	): Promise<Error | undefined> {
		if (!identity) {
			return undefined;
		}
		const body: k8s.V1DeleteOptions = {
			preconditions: {
				uid: identity.uid,
			},
			propagationPolicy,
		};
		if (resourceVersion.length > 0) {
			body.preconditions ??= {};
			body.preconditions.resourceVersion = resourceVersion;
		}
		try {
			if (identity.apiVersion === "apps/v1" && identity.kind === "Deployment") {
				await this.api.appsv1.deleteNamespacedDeployment({
					name: identity.name,
					namespace: identity.namespace,
					propagationPolicy,
					body,
				});
				return undefined;
			}
			if (identity.apiVersion === "apps/v1" && identity.kind === "ReplicaSet") {
				await this.api.appsv1.deleteNamespacedReplicaSet({
					name: identity.name,
					namespace: identity.namespace,
					propagationPolicy,
					body,
				});
				return undefined;
			}
			if (identity.apiVersion === "v1" && identity.kind === "Node") {
				await this.api.corev1.deleteNode({
					name: identity.name,
					propagationPolicy,
					body,
				});
				return undefined;
			}
			if (identity.apiVersion === "v1" && identity.kind === "Pod") {
				await this.api.corev1.deleteNamespacedPod({
					name: identity.name,
					namespace: identity.namespace,
					gracePeriodSeconds: 0,
					propagationPolicy,
					body: { ...body, gracePeriodSeconds: 0 },
				});
				return undefined;
			}
			if (identity.apiVersion === "v1" && identity.kind === "Service") {
				await this.api.corev1.deleteNamespacedService({
					name: identity.name,
					namespace: identity.namespace,
					propagationPolicy,
					body,
				});
				return undefined;
			}
			if (identity.apiVersion === "discovery.k8s.io/v1" && identity.kind === "EndpointSlice") {
				await this.api.discoveryv1.deleteNamespacedEndpointSlice({
					name: identity.name,
					namespace: identity.namespace,
					propagationPolicy,
					body,
				});
				return undefined;
			}
			throw unsupportedObjectResourceError(identity);
		} catch (error) {
			const err = errorAsError(error);
			if (isConflictError(err) && resourceVersion.length > 0) {
				const [liveObject, liveErr] = await this.getObject(identity);
				if (isNotFoundError(liveErr)) {
					return liveErr;
				}
				if (
					!liveErr &&
					liveObject?.metadata?.uid === identity.uid &&
					liveObject.metadata?.resourceVersion !== resourceVersion &&
					deepEqual(liveObject.metadata?.ownerReferences ?? [], ownersAtResourceVersion)
				) {
					return await this.deleteObject(ctx, identity, "", [], propagationPolicy);
				}
			}
			return err;
		}
	}
}

// TODO(samwho): we need to centralise this
// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go apiResource.
function resourceIsNamespaced(reference: k8s.V1OwnerReference): boolean {
	if (reference.apiVersion === "apps/v1" && reference.kind === "Deployment") {
		return true;
	}
	if (reference.apiVersion === "apps/v1" && reference.kind === "ReplicaSet") {
		return true;
	}
	if (reference.apiVersion === "v1" && reference.kind === "Node") {
		return false;
	}
	if (reference.apiVersion === "v1" && reference.kind === "Pod") {
		return true;
	}
	if (reference.apiVersion === "v1" && reference.kind === "Service") {
		return true;
	}
	if (reference.apiVersion === "discovery.k8s.io/v1" && reference.kind === "EndpointSlice") {
		return true;
	}
	throw new Error(`unsupported object resource ${reference.apiVersion}/${reference.kind}`);
}

// Models kubernetes/pkg/controller/garbagecollector/garbagecollector.go ownerRefsToUIDs.
function ownerRefsToUIDs(refs: k8s.V1OwnerReference[]): string[] {
	const ret: string[] = [];
	for (const ref of refs) {
		ret.push(ref.uid ?? "");
	}
	return ret;
}

async function errorFrom(fn: () => Promise<void>): Promise<Error | undefined> {
	try {
		await fn();
		return undefined;
	} catch (error) {
		return errorAsError(error);
	}
}

function errorAsError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function unsupportedObjectResourceError(identity: ObjectReference): Error {
	return new Error(`unsupported object resource ${identity.apiVersion}/${identity.kind}`);
}

function decodePatch(data: Uint8Array): Record<string, unknown> {
	const body = JSON.parse(new TextDecoder().decode(data)) as unknown;
	if (!isRecord(body)) {
		throw new Error("decoded patch must be an object");
	}
	return body;
}

// Models encoding/json Marshal.
function jsonMarshal(value: unknown): MarshalResult {
	try {
		return [new TextEncoder().encode(JSON.stringify(value)), undefined];
	} catch (error) {
		return [undefined, errorAsError(error)];
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
