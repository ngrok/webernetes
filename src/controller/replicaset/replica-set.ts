/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import * as k8s from "../../client";
import {
	getControllerOf,
	newControllerRef,
} from "../../apimachinery/pkg/apis/meta/v1/controller_ref";
import { labelSelectorAsSelector } from "../../apimachinery/pkg/apis/meta/v1/helpers";
import { Set as LabelSet } from "../../apimachinery/pkg/labels/labels";
import type { Selector } from "../../apimachinery/pkg/labels/selector";
import {
	GroupResource,
	GroupVersionKind,
} from "../../apimachinery/pkg/runtime/schema/group_version";
import { hasStatusCause, isNotFoundError } from "../../client/errors";
import {
	newReplicaSetLister,
	type ReplicaSetLister,
} from "../../client-go/listers/apps/v1/replicaset";
import { newPodLister, type PodLister } from "../../client-go/listers/core/v1/pod";
import type { Indexer } from "../../client-go/tools/cache/index";
import {
	DeletedFinalStateUnknown,
	ExplicitKey,
	metaNamespaceKeyFunc,
	newIndexer,
	splitMetaNamespaceKey,
} from "../../client-go/tools/cache/store";
import { defaultTypedControllerRateLimiter } from "../../client-go/util/workqueue/default-rate-limiters";
import {
	newTypedRateLimitingQueueWithConfig,
	type TypedRateLimitingInterface,
} from "../../client-go/util/workqueue/rate-limiting-queue";
import { EventRecorderImpl } from "../../cluster/events";
import { getClock } from "../../clock-context";
import { newPodControllerRefManager, recheckDeletionTimestamp } from "../controller-ref-manager";
import {
	newConsistencyStore,
	type ConsistencyStore,
	type LastSyncRVGetter,
} from "../util/consistency/consistency";
import {
	ActivePodsWithRanks,
	addPodControllerIndexer,
	filterPodsByOwner,
	findMinNextPodAvailabilityCheck,
	isPodActive,
	isPodTerminating,
	keyFunc,
	newControllerExpectations,
	RealPodControl,
	newUIDTrackingControllerExpectations,
	podKey,
	type PodControlInterface,
	type UIDTrackingControllerExpectations,
} from "../controller-utils";
import { deepEqual } from "../../deep-equal";
import type * as context from "../../go/context";
import type { Clock } from "../../clock";
import { untilWithContext } from "../../apimachinery/pkg/util/wait/backoff";

const defaultBurstReplicas = 500;
const statusUpdateRetries = 1;
const slowStartInitialBatchSize = 1;
const controllerUIDIndex = "controllerUID";
const replicaSetGroupResource = new GroupResource("apps", "replicasets");
const podGroupResource = new GroupResource("", "pods");
const replicaSetControllerKind = new GroupVersionKind("apps", "v1", "ReplicaSet");
const namespaceTerminatingCause = "NamespaceTerminating";

// Models kubernetes/pkg/controller/replicaset/replica_set.go ReplicaSetControllerFeatures.
export interface ReplicaSetControllerFeatures {
	enableStatusTerminatingReplicas: boolean;
}

// Models kubernetes/pkg/controller/replicaset/replica_set.go DefaultReplicaSetControllerFeatures.
export function defaultReplicaSetControllerFeatures(): ReplicaSetControllerFeatures {
	return {
		enableStatusTerminatingReplicas: true,
	};
}

// Models kubernetes/pkg/controller/replicaset/replica_set.go ReplicaSetController.
export class ReplicaSetController {
	readonly groupVersionKind: GroupVersionKind;
	readonly kind: string;
	private replicaSetInformer: k8s.Informer<k8s.V1ReplicaSet> | undefined;
	private podInformer: k8s.Informer<k8s.V1Pod> | undefined;
	private readonly api: k8s.KubeClient;
	private readonly kubeConfig: k8s.KubeConfig;
	readonly podControl: PodControlInterface;
	readonly podIndexer: Indexer<k8s.V1Pod>;
	private readonly burstReplicas: number;
	syncHandler = async (ctx: context.Context, key: string): Promise<Error | undefined> =>
		await this.syncReplicaSet(ctx, key);
	readonly expectations: UIDTrackingControllerExpectations;
	readonly rsLister: ReplicaSetLister;
	readonly rsIndexer: Indexer<k8s.V1ReplicaSet>;
	private readonly podLister: PodLister;
	queue: TypedRateLimitingInterface<string>;
	private readonly clock: Clock;
	readonly consistencyStore: ConsistencyStore;
	private readonly controllerFeatures: ReplicaSetControllerFeatures;

	constructor(
		api: k8s.KubeClient,
		kubeConfig: k8s.KubeConfig,
		controllerFeatures = defaultReplicaSetControllerFeatures(),
		burstReplicas = defaultBurstReplicas,
		podControl?: PodControlInterface,
	) {
		this.groupVersionKind = replicaSetControllerKind;
		this.kind = this.groupVersionKind.kind;
		this.api = api;
		this.kubeConfig = kubeConfig;
		this.burstReplicas = burstReplicas;
		this.clock = getClock(kubeConfig.options.ctx);
		this.controllerFeatures = controllerFeatures;
		this.queue = newTypedRateLimitingQueueWithConfig(defaultTypedControllerRateLimiter<string>(), {
			clock: this.clock,
		});
		this.rsIndexer = newIndexer(metaNamespaceKeyFunc, {
			[controllerUIDIndex]: replicaSetControllerUIDIndexFunc,
		});
		this.podIndexer = newIndexer(podKeyFunc, {});
		addPodControllerIndexer(this.podIndexer);
		this.rsLister = newReplicaSetLister(this.rsIndexer);
		this.podLister = newPodLister(this.podIndexer);
		this.expectations = newUIDTrackingControllerExpectations(
			newControllerExpectations(kubeConfig.options.ctx),
		);
		this.consistencyStore = newConsistencyStore(
			new Map<string, LastSyncRVGetter>([
				[podGroupResource.toString(), this.podIndexer],
				[replicaSetGroupResource.toString(), this.rsIndexer],
			]),
		);
		this.podControl =
			podControl ??
			new RealPodControl(
				api.corev1,
				new EventRecorderImpl({
					ctx: kubeConfig.options.ctx,
					api: api.corev1,
					component: "replicaset-controller",
				}),
				(pod, controllerRef) => {
					if (!controllerRef) {
						return;
					}
					this.consistencyStore.wroteAt(
						{ namespace: pod.metadata?.namespace ?? "default", name: controllerRef.name ?? "" },
						controllerRef.uid ?? "",
						podGroupResource,
						pod.metadata?.resourceVersion ?? "",
					);
				},
			);
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go Run.
	async run(ctx: context.Context): Promise<void> {
		await this.startInformers(ctx);
		void untilWithContext(ctx, async (workerCtx) => await this.worker(workerCtx), 1000);
		await ctx.done().receive();
	}

	async stop(): Promise<void> {
		await this.replicaSetInformer?.stop();
		await this.podInformer?.stop();
		await this.queue.shutDown();
	}

	private async startInformers(ctx: context.Context): Promise<void> {
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
		this.replicaSetInformer.on("add", (replicaSet) => {
			void (async () => {
				await this.rsIndexer.add(replicaSet);
				await this.addRS(ctx, replicaSet);
			})();
		});
		this.replicaSetInformer.on("update", (replicaSet) => {
			void (async () => {
				const [key, err] = keyFunc(replicaSet);
				if (err) {
					return;
				}
				const [oldReplicaSet] = this.rsIndexer.getByKey(key);
				await this.rsIndexer.update(replicaSet);
				await this.updateRS(ctx, oldReplicaSet ?? replicaSet, replicaSet);
			})();
		});
		this.replicaSetInformer.on("delete", (replicaSet) => {
			void (async () => {
				await this.rsIndexer.delete(replicaSet);
				await this.deleteRS(ctx, replicaSet);
			})();
		});
		this.podInformer.on("add", (pod) => {
			void (async () => {
				await this.podIndexer.add(pod);
				await this.addPod(ctx, pod);
			})();
		});
		this.podInformer.on("update", (pod) => {
			void (async () => {
				const [oldPod] = this.podIndexer.getByKey(podKey(pod));
				await this.podIndexer.update(pod);
				await this.updatePod(ctx, oldPod ?? pod, pod);
			})();
		});
		this.podInformer.on("delete", (pod) => {
			void (async () => {
				const deletedPod = pod instanceof DeletedFinalStateUnknown ? pod.obj : pod;
				await this.podIndexer.delete(deletedPod);
				await this.deletePod(ctx, pod);
			})();
		});
		await this.replicaSetInformer.start();
		await this.podInformer.start();
		for (const replicaSet of this.rsIndexer.list()) {
			this.enqueueRS(replicaSet);
		}
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go getReplicaSetsWithSameController.
	getReplicaSetsWithSameController(rs: k8s.V1ReplicaSet): k8s.V1ReplicaSet[] {
		const controllerRef = getControllerOf(rs);
		if (!controllerRef) {
			return [];
		}
		const [objects, err] = this.rsIndexer.byIndex(controllerUIDIndex, controllerRef.uid ?? "");
		if (err) {
			return [];
		}
		return objects;
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go getPodReplicaSets.
	getPodReplicaSets(pod: k8s.V1Pod): k8s.V1ReplicaSet[] {
		const [rss, err] = this.rsLister.getPodReplicaSets(pod);
		if (err) {
			return [];
		}
		return rss;
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go resolveControllerRef.
	private resolveControllerRef(
		namespace: string | undefined,
		controllerRef: k8s.V1OwnerReference | undefined,
	): k8s.V1ReplicaSet | undefined {
		if (!controllerRef || controllerRef.kind !== this.kind) {
			return undefined;
		}
		const [rs, err] = this.rsLister
			.replicaSets(namespace ?? "default")
			.get(controllerRef.name ?? "");
		if (err) {
			return undefined;
		}
		if (!rs || rs.metadata?.uid !== controllerRef.uid) {
			return undefined;
		}
		return rs;
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go enqueueRS.
	enqueueRS(rs: k8s.V1ReplicaSet): void {
		const [key, err] = keyFunc(rs);
		if (err) {
			return;
		}
		this.queue.add(key);
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go enqueueRSAfter.
	private enqueueRSAfter(rs: k8s.V1ReplicaSet, durationMs: number): void {
		const [key, err] = keyFunc(rs);
		if (err) {
			return;
		}
		void this.queue.addAfter(key, durationMs);
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go addRS.
	private async addRS(_ctx: context.Context, rs: k8s.V1ReplicaSet): Promise<void> {
		this.enqueueRS(rs);
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go updateRS.
	private async updateRS(
		ctx: context.Context,
		oldRS: k8s.V1ReplicaSet,
		curRS: k8s.V1ReplicaSet,
	): Promise<void> {
		if (curRS.metadata?.uid !== oldRS.metadata?.uid) {
			const [oldKey, oldKeyErr] = keyFunc(oldRS);
			if (oldKeyErr) {
				return;
			}
			await this.deleteRS(ctx, new DeletedFinalStateUnknown(oldKey, oldRS));
		}
		this.enqueueRS(curRS);
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go deleteRS.
	async deleteRS(
		_ctx: context.Context,
		rs: k8s.V1ReplicaSet | DeletedFinalStateUnknown<k8s.V1ReplicaSet>,
	): Promise<void> {
		const deletedRS = rs instanceof DeletedFinalStateUnknown ? rs.obj : rs;
		const [key, err] = keyFunc(deletedRS);
		if (err) {
			return;
		}
		this.consistencyStore.clear(
			{
				namespace: deletedRS.metadata?.namespace ?? "default",
				name: deletedRS.metadata?.name ?? "",
			},
			deletedRS.metadata?.uid ?? "",
		);
		await this.expectations.deleteExpectations(key);
		this.queue.add(key);
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go addPod.
	async addPod(ctx: context.Context, pod: k8s.V1Pod): Promise<void> {
		if (pod.metadata?.deletionTimestamp) {
			await this.deletePod(ctx, pod);
			return;
		}
		const controllerRef = getControllerOf(pod);
		if (controllerRef) {
			const rs = this.resolveControllerRef(pod.metadata?.namespace, controllerRef);
			if (!rs) {
				return;
			}
			const [rsKey, err] = keyFunc(rs);
			if (err) {
				return;
			}
			await this.expectations.creationObserved(rsKey);
			this.queue.add(rsKey);
			return;
		}
		const rss = this.getPodReplicaSets(pod);
		for (const rs of rss) {
			this.enqueueRS(rs);
		}
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go updatePod.
	async updatePod(ctx: context.Context, old: k8s.V1Pod, cur: k8s.V1Pod): Promise<void> {
		const curPod = cur;
		const oldPod = old;
		if (curPod.metadata?.resourceVersion === oldPod.metadata?.resourceVersion) {
			return;
		}

		const labelChanged = !deepEqual(curPod.metadata?.labels ?? {}, oldPod.metadata?.labels ?? {}, {
			ignoreUndefined: true,
		});
		if (curPod.metadata?.deletionTimestamp) {
			await this.deletePod(ctx, curPod);
			if (labelChanged) {
				await this.deletePod(ctx, oldPod);
			}
			return;
		}

		const curControllerRef = getControllerOf(curPod);
		const oldControllerRef = getControllerOf(oldPod);
		const controllerRefChanged = !deepEqual(curControllerRef ?? {}, oldControllerRef ?? {}, {
			ignoreUndefined: true,
		});
		if (controllerRefChanged && oldControllerRef) {
			const rs = this.resolveControllerRef(oldPod.metadata?.namespace, oldControllerRef);
			if (rs) {
				this.enqueueRS(rs);
			}
		}

		if (curControllerRef) {
			const rs = this.resolveControllerRef(curPod.metadata?.namespace, curControllerRef);
			if (!rs) {
				return;
			}
			this.enqueueRS(rs);
			if (!isPodReady(oldPod) && isPodReady(curPod) && (rs.spec?.minReadySeconds ?? 0) > 0) {
				this.enqueueRSAfter(rs, (rs.spec?.minReadySeconds ?? 0) * 1000);
			}
			return;
		}

		if (labelChanged || controllerRefChanged) {
			const rss = this.getPodReplicaSets(curPod);
			for (const rs of rss) {
				this.enqueueRS(rs);
			}
		}
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go deletePod.
	async deletePod(
		_ctx: context.Context,
		pod: k8s.V1Pod | DeletedFinalStateUnknown<k8s.V1Pod>,
	): Promise<void> {
		const deletedPod = pod instanceof DeletedFinalStateUnknown ? pod.obj : pod;
		const controllerRef = getControllerOf(deletedPod);
		if (!controllerRef) {
			return;
		}
		const rs = this.resolveControllerRef(deletedPod.metadata?.namespace, controllerRef);
		if (!rs) {
			return;
		}
		const [rsKey, err] = keyFunc(rs);
		if (err) {
			return;
		}
		await this.expectations.deletionObserved(rsKey, podKey(deletedPod));
		this.queue.add(rsKey);
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go worker.
	async worker(ctx: context.Context): Promise<void> {
		while (await this.processNextWorkItem(ctx)) {}
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go processNextWorkItem.
	async processNextWorkItem(ctx: context.Context): Promise<boolean> {
		const [key, quit] = await this.queue.get();
		if (quit) {
			return false;
		}
		if (key === undefined) {
			return true;
		}
		try {
			const err = await this.syncHandler(ctx, key);
			if (err) {
				await this.queue.addRateLimited(key);
			} else {
				this.queue.forget(key);
			}
		} finally {
			this.queue.done(key);
		}
		return true;
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go manageReplicas.
	private async manageReplicas(
		ctx: context.Context,
		activePods: k8s.V1Pod[],
		rs: k8s.V1ReplicaSet,
	): Promise<Error | undefined> {
		let diff = activePods.length - (rs.spec?.replicas ?? 1);
		const [rsKey, rsKeyErr] = keyFunc(rs);
		if (rsKeyErr) {
			return undefined;
		}
		if (diff < 0) {
			diff *= -1;
			if (diff > this.burstReplicas) {
				diff = this.burstReplicas;
			}
			await this.expectations.expectCreations(rsKey, diff);
			const [successfulCreations, err] = await slowStartBatch(
				diff,
				slowStartInitialBatchSize,
				async () => {
					const err = await this.podControl.createPods(
						ctx,
						rs.metadata?.namespace ?? "default",
						rs.spec?.template ?? {},
						rs,
						newControllerRef(rs, this.groupVersionKind),
					);
					if (err && hasStatusCause(err, namespaceTerminatingCause)) {
						return undefined;
					}
					return err;
				},
			);
			const skippedPods = diff - successfulCreations;
			if (skippedPods > 0) {
				for (let i = 0; i < skippedPods; i++) {
					await this.expectations.creationObserved(rsKey);
				}
			}
			return err;
		} else if (diff > 0) {
			if (diff > this.burstReplicas) {
				diff = this.burstReplicas;
			}
			const [relatedPods] = this.getIndirectlyRelatedPods(rs);
			const podsToDelete = getPodsToDelete(ctx, activePods, relatedPods, diff);
			await this.expectations.expectDeletions(rsKey, getPodKeys(podsToDelete));
			const errors = await Promise.all(
				podsToDelete.map(async (pod) => {
					const podName = pod.metadata?.name;
					if (!podName) {
						return undefined;
					}
					const err = await this.podControl.deletePod(
						ctx,
						rs.metadata?.namespace ?? "default",
						podName,
						rs,
					);
					if (err) {
						await this.expectations.deletionObserved(rsKey, podKey(pod));
						if (!isNotFoundError(err)) {
							return err;
						}
					}
					return undefined;
				}),
			);
			const err = errors.find((error) => error);
			if (err) {
				return err;
			}
		}
		return undefined;
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go syncReplicaSet.
	async syncReplicaSet(ctx: context.Context, key: string): Promise<Error | undefined> {
		const [namespace, name, keyErr] = splitMetaNamespaceKey(key);
		if (keyErr) {
			return keyErr;
		}
		const rsNamespacedName = { namespace, name };
		const consistencyErr = this.consistencyStore.ensureReady(rsNamespacedName);
		if (consistencyErr) {
			return consistencyErr;
		}
		const [rs, err] = this.rsLister.replicaSets(namespace).get(name);
		if (err) {
			if (isReplicaSetNotFoundError(err, name)) {
				this.consistencyStore.clear(rsNamespacedName, "");
				await this.expectations.deleteExpectations(key);
				return undefined;
			}
			return err;
		}
		if (!rs) {
			this.consistencyStore.clear(rsNamespacedName, "");
			await this.expectations.deleteExpectations(key);
			return undefined;
		}
		const rsNeedsSync = this.expectations.satisfiedExpectations(key);
		const [selector, selectorErr] = labelSelectorAsSelector(rs.spec?.selector);
		if (selectorErr || !selector) {
			return undefined;
		}
		const [allRSPods, allRSPodsErr] = filterPodsByOwner(
			this.podIndexer,
			rs.metadata ?? {},
			this.kind,
			true,
		);
		if (allRSPodsErr) {
			return allRSPodsErr;
		}
		const allActivePods = filterActivePods(allRSPods);
		const [activePods, claimPodsErr] = await this.claimPods(ctx, rs, selector, allActivePods);
		if (claimPodsErr) {
			return claimPodsErr;
		}
		let terminatingPods: k8s.V1Pod[] = [];
		if (this.controllerFeatures.enableStatusTerminatingReplicas) {
			const allTerminatingPods = filterTerminatingPods(allRSPods);
			terminatingPods = filterClaimedPods(rs, selector, allTerminatingPods);
		}

		let manageReplicasErr: Error | undefined;
		let nextSyncDuration: number | undefined;
		if (rsNeedsSync && !rs.metadata?.deletionTimestamp) {
			manageReplicasErr = await this.manageReplicas(ctx, activePods, rs);
		}

		const rsForStatus = structuredClone(rs);
		const now = this.clock.now();
		const newStatus = calculateStatus(
			rsForStatus,
			activePods,
			terminatingPods,
			manageReplicasErr,
			this.controllerFeatures,
			now,
		);
		const [updatedRS, updateErr] = await updateReplicaSetStatus(
			this.api.appsv1,
			namespace,
			name,
			rsForStatus,
			newStatus,
			this.controllerFeatures,
		);
		if (updateErr || !updatedRS) {
			return updateErr ?? new Error("failed to update ReplicaSet status");
		}
		this.consistencyStore.wroteAt(
			{ name: rs.metadata?.name ?? "", namespace: rs.metadata?.namespace ?? "default" },
			rs.metadata?.uid ?? "",
			replicaSetGroupResource,
			updatedRS.metadata?.resourceVersion ?? "",
		);
		if (manageReplicasErr) {
			return manageReplicasErr;
		}
		if (
			(updatedRS.spec?.minReadySeconds ?? 0) > 0 &&
			(updatedRS.status?.readyReplicas ?? 0) !== (updatedRS.status?.availableReplicas ?? 0)
		) {
			nextSyncDuration = (updatedRS.spec?.minReadySeconds ?? 0) * 1000;
			const nextCheck = findMinNextPodAvailabilityCheck(
				activePods,
				updatedRS.spec?.minReadySeconds ?? 0,
				now,
				this.clock,
			);
			if (nextCheck !== undefined) {
				nextSyncDuration = nextCheck;
			}
		}
		if (nextSyncDuration !== undefined) {
			void this.queue.addAfter(key, nextSyncDuration);
		}
		return undefined;
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go claimPods.
	private async claimPods(
		ctx: context.Context,
		rs: k8s.V1ReplicaSet,
		selector: Selector,
		filteredPods: k8s.V1Pod[],
	): Promise<[k8s.V1Pod[], Error | undefined]> {
		const canAdoptFunc = recheckDeletionTimestamp(async () => {
			try {
				const fresh = await this.api.appsv1.readNamespacedReplicaSet({
					name: rs.metadata?.name ?? "",
					namespace: rs.metadata?.namespace ?? "default",
				});
				if (fresh.metadata?.uid !== rs.metadata?.uid) {
					return [
						undefined,
						new Error(
							`original ReplicaSet ${rs.metadata?.namespace}/${rs.metadata?.name} is gone: got uid ${fresh.metadata?.uid}, wanted ${rs.metadata?.uid}`,
						),
					];
				}
				return [fresh, undefined];
			} catch (error) {
				return [undefined, toError(error)];
			}
		});
		const cm = newPodControllerRefManager(
			this.podControl,
			rs,
			selector,
			this.groupVersionKind,
			canAdoptFunc,
		);
		return await cm.claimPods(ctx, filteredPods);
	}

	// Models kubernetes/pkg/controller/replicaset/replica_set.go getIndirectlyRelatedPods.
	getIndirectlyRelatedPods(rs: k8s.V1ReplicaSet): [k8s.V1Pod[], Error | undefined] {
		const relatedPods: k8s.V1Pod[] = [];
		const seen = new Map<string, k8s.V1ReplicaSet>();
		for (const relatedRS of this.getReplicaSetsWithSameController(rs)) {
			const [selector, selectorErr] = labelSelectorAsSelector(relatedRS.spec?.selector);
			if (selectorErr || !selector) {
				continue;
			}
			const [pods, err] = this.podLister
				.pods(relatedRS.metadata?.namespace ?? "default")
				.list(selector);
			if (err) {
				return [[], err];
			}
			for (const pod of pods) {
				const uid = pod.metadata?.uid;
				if (uid && seen.has(uid)) {
					continue;
				}
				if (uid) {
					seen.set(uid, relatedRS);
				}
				relatedPods.push(pod);
			}
		}
		return [relatedPods, undefined];
	}
}

// Models kubernetes/pkg/controller/replicaset/replica_set_utils.go updateReplicaSetStatus.
export async function updateReplicaSetStatus(
	api: k8s.KubeClient["appsv1"],
	namespace: string,
	name: string,
	rs: k8s.V1ReplicaSet,
	newStatus: k8s.V1ReplicaSetStatus,
	_controllerFeatures: ReplicaSetControllerFeatures,
): Promise<[k8s.V1ReplicaSet | undefined, Error | undefined]> {
	if (
		(rs.status?.replicas ?? 0) === newStatus.replicas &&
		(rs.status?.fullyLabeledReplicas ?? 0) === newStatus.fullyLabeledReplicas &&
		(rs.status?.readyReplicas ?? 0) === newStatus.readyReplicas &&
		(rs.status?.availableReplicas ?? 0) === newStatus.availableReplicas &&
		ptrEqual(rs.status?.terminatingReplicas, newStatus.terminatingReplicas) &&
		rs.metadata?.generation === rs.status?.observedGeneration &&
		deepEqual(rs.status?.conditions ?? [], newStatus.conditions ?? [], { ignoreUndefined: true })
	) {
		return [rs, undefined];
	}

	newStatus.observedGeneration = rs.metadata?.generation;

	let getErr: Error | undefined;
	let updateErr: Error | undefined;
	let updatedRS: k8s.V1ReplicaSet | undefined;
	for (let i = 0, current = rs; ; i++) {
		try {
			current.status = newStatus;
			updatedRS = await api.replaceNamespacedReplicaSetStatus({
				name,
				namespace,
				body: current,
			});
			return [updatedRS, undefined];
		} catch (error) {
			updateErr = toError(error);
		}
		if (i >= statusUpdateRetries) {
			break;
		}
		try {
			current = await api.readNamespacedReplicaSet({ name, namespace });
		} catch (error) {
			getErr = toError(error);
			return [undefined, getErr];
		}
	}

	return [undefined, updateErr];
}

// Models kubernetes/pkg/controller/replicaset/replica_set_utils.go calculateStatus.
export function calculateStatus(
	rs: k8s.V1ReplicaSet,
	activePods: k8s.V1Pod[],
	terminatingPods: k8s.V1Pod[],
	manageReplicasErr: Error | undefined,
	controllerFeatures: ReplicaSetControllerFeatures,
	now: Date,
): k8s.V1ReplicaSetStatus {
	const newStatus: k8s.V1ReplicaSetStatus = { replicas: 0, ...(rs.status ?? {}) };
	let fullyLabeledReplicasCount = 0;
	let readyReplicasCount = 0;
	let availableReplicasCount = 0;
	const templateLabel = new LabelSet(rs.spec?.template?.metadata?.labels).asSelectorPreValidated();
	for (const pod of activePods) {
		if (templateLabel.matches(new LabelSet(pod.metadata?.labels))) {
			fullyLabeledReplicasCount++;
		}
		if (isPodReady(pod)) {
			readyReplicasCount++;
			if (isPodAvailable(pod, rs.spec?.minReadySeconds ?? 0, now)) {
				availableReplicasCount++;
			}
		}
	}

	const terminatingReplicasCount = controllerFeatures.enableStatusTerminatingReplicas
		? terminatingPods.length
		: undefined;

	const failureCond = getCondition(rs.status, "ReplicaFailure");
	if (manageReplicasErr && !failureCond) {
		let reason = "";
		const diff = activePods.length - (rs.spec?.replicas ?? 1);
		if (diff < 0) {
			reason = "FailedCreate";
		} else if (diff > 0) {
			reason = "FailedDelete";
		}
		const cond = newReplicaSetCondition(
			"ReplicaFailure",
			"True",
			reason,
			manageReplicasErr.message,
			now,
		);
		setCondition(newStatus, cond);
	} else if (!manageReplicasErr && failureCond) {
		removeCondition(newStatus, "ReplicaFailure");
	}

	newStatus.replicas = activePods.length;
	newStatus.fullyLabeledReplicas = fullyLabeledReplicasCount;
	newStatus.readyReplicas = readyReplicasCount;
	newStatus.availableReplicas = availableReplicasCount;
	newStatus.terminatingReplicas = terminatingReplicasCount;
	return newStatus;
}

// Models kubernetes/pkg/controller/replicaset/replica_set_utils.go NewReplicaSetCondition.
export function newReplicaSetCondition(
	condType: string,
	status: string,
	reason: string,
	message: string,
	now: Date,
): k8s.V1ReplicaSetCondition {
	return {
		type: condType,
		status,
		lastTransitionTime: now,
		reason,
		message,
	};
}

// Models kubernetes/pkg/controller/replicaset/replica_set_utils.go GetCondition.
export function getCondition(
	status: k8s.V1ReplicaSetStatus | undefined,
	condType: string,
): k8s.V1ReplicaSetCondition | undefined {
	return (status?.conditions ?? []).find((condition) => condition.type === condType);
}

// Models kubernetes/pkg/controller/replicaset/replica_set_utils.go SetCondition.
export function setCondition(
	status: k8s.V1ReplicaSetStatus,
	condition: k8s.V1ReplicaSetCondition,
): void {
	const currentCond = getCondition(status, condition.type ?? "");
	if (
		currentCond &&
		currentCond.status === condition.status &&
		currentCond.reason === condition.reason
	) {
		return;
	}
	status.conditions = filterOutCondition(status.conditions ?? [], condition.type ?? "");
	status.conditions.push(condition);
}

// Models kubernetes/pkg/controller/replicaset/replica_set_utils.go RemoveCondition.
export function removeCondition(status: k8s.V1ReplicaSetStatus, condType: string): void {
	const conditions = filterOutCondition(status.conditions ?? [], condType);
	status.conditions = conditions.length > 0 ? conditions : undefined;
}

// Models kubernetes/pkg/controller/replicaset/replica_set_utils.go filterOutCondition.
export function filterOutCondition(
	conditions: k8s.V1ReplicaSetCondition[],
	condType: string,
): k8s.V1ReplicaSetCondition[] {
	return conditions.filter((condition) => condition.type !== condType);
}

// Models kubernetes/pkg/controller/replicaset/replica_set.go slowStartBatch.
export async function slowStartBatch(
	count: number,
	initialBatchSize: number,
	fn: () => Promise<Error | undefined>,
): Promise<[number, Error | undefined]> {
	let remaining = count;
	let successes = 0;
	for (
		let batchSize = Math.min(remaining, initialBatchSize);
		batchSize > 0;
		batchSize = Math.min(2 * batchSize, remaining)
	) {
		const errors = await Promise.all(Array.from({ length: batchSize }, () => fn()));
		const err = errors.find((error) => error);
		const curSuccesses = errors.filter((error) => !error).length;
		successes += curSuccesses;
		if (err) {
			return [successes, err];
		}
		remaining -= batchSize;
	}
	return [successes, undefined];
}

// Models kubernetes/pkg/controller/replicaset/replica_set.go getPodsToDelete.
export function getPodsToDelete(
	ctx: context.Context,
	filteredPods: k8s.V1Pod[],
	relatedPods: k8s.V1Pod[],
	diff: number,
): k8s.V1Pod[] {
	if (diff < filteredPods.length) {
		const podsWithRanks = getPodsRankedByRelatedPodsOnSameNode(ctx, filteredPods, relatedPods);
		podsWithRanks.sort();
		reportSortingDeletionAgeRatioMetric(filteredPods, diff);
	}
	return filteredPods.slice(0, diff);
}

// Models kubernetes/pkg/controller/replicaset/replica_set.go getPodsRankedByRelatedPodsOnSameNode.
function getPodsRankedByRelatedPodsOnSameNode(
	ctx: context.Context,
	podsToRank: k8s.V1Pod[],
	relatedPods: k8s.V1Pod[],
): ActivePodsWithRanks {
	const podsOnNode = new Map<string, number>();
	for (const pod of relatedPods) {
		if (isPodActive(pod)) {
			const nodeName = pod.spec?.nodeName ?? "";
			podsOnNode.set(nodeName, (podsOnNode.get(nodeName) ?? 0) + 1);
		}
	}
	return new ActivePodsWithRanks(
		podsToRank,
		podsToRank.map((pod) => podsOnNode.get(pod.spec?.nodeName ?? "") ?? 0),
		getClock(ctx).now(),
	);
}

// Models kubernetes/pkg/controller/replicaset/replica_set.go reportSortingDeletionAgeRatioMetric.
function reportSortingDeletionAgeRatioMetric(_filteredPods: k8s.V1Pod[], _diff: number): void {
	return;
}

// Models kubernetes/pkg/controller/replicaset/replica_set.go getPodKeys.
export function getPodKeys(pods: k8s.V1Pod[]): string[] {
	const podKeys: string[] = [];
	for (const pod of pods) {
		podKeys.push(podKey(pod));
	}
	return podKeys;
}

// Models kubernetes/pkg/controller/replicaset/replica_set.go controllerUIDIndex.
function replicaSetControllerUIDIndexFunc(
	replicaSet: k8s.V1ReplicaSet,
): [string[], Error | undefined] {
	const controllerRef = getControllerOf(replicaSet);
	if (!controllerRef) {
		return [[], undefined];
	}
	return [[controllerRef.uid ?? ""], undefined];
}

// Models staging/src/k8s.io/client-go/tools/cache/store.go MetaNamespaceKeyFunc.
function podKeyFunc(pod: k8s.V1Pod | ExplicitKey): [string, Error | undefined] {
	if (pod instanceof ExplicitKey) {
		return [pod.key, undefined];
	}
	return [podKey(pod), undefined];
}

// Models staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/controller_ref.go IsControlledBy.
function isControlledBy(resource: k8s.KubernetesObject, owner: k8s.KubernetesObject): boolean {
	const uid = owner.metadata?.uid;
	return !!uid && getControllerOf(resource)?.uid === uid;
}

// Models kubernetes/pkg/controller/controller_utils.go FilterActivePods.
function filterActivePods(pods: k8s.V1Pod[]): k8s.V1Pod[] {
	return pods.filter(isPodActive);
}

// Models kubernetes/pkg/controller/controller_utils.go FilterTerminatingPods.
function filterTerminatingPods(pods: k8s.V1Pod[]): k8s.V1Pod[] {
	return pods.filter(isPodTerminating);
}

// Models kubernetes/pkg/controller/controller_utils.go FilterClaimedPods.
function filterClaimedPods(
	rs: k8s.V1ReplicaSet,
	selector: Selector,
	pods: k8s.V1Pod[],
): k8s.V1Pod[] {
	return pods.filter(
		(pod) => isControlledBy(pod, rs) && selector.matches(new LabelSet(pod.metadata?.labels)),
	);
}

// Models kubernetes/pkg/api/v1/pod/util.go IsPodReady.
function isPodReady(pod: k8s.V1Pod | undefined): boolean {
	return !!pod && readyCondition(pod)?.status === "True";
}

// Models kubernetes/pkg/api/v1/pod/util.go IsPodAvailable.
function isPodAvailable(pod: k8s.V1Pod, minReadySeconds: number, now: Date): boolean {
	const condition = readyCondition(pod);
	if (condition?.status !== "True") {
		return false;
	}
	if (minReadySeconds === 0) {
		return true;
	}
	const readyAtMs = timestampMs(condition.lastTransitionTime);
	return readyAtMs !== undefined && now.getTime() - readyAtMs >= minReadySeconds * 1000;
}

// Models kubernetes/pkg/api/v1/pod/util.go GetPodReadyCondition.
function readyCondition(pod: k8s.V1Pod): k8s.V1PodCondition | undefined {
	return (pod.status?.conditions ?? []).find((condition) => condition.type === "Ready");
}

function timestampMs(value: Date | string | undefined): number | undefined {
	if (value instanceof Date) {
		return value.getTime();
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

// Models k8s.io/utils/ptr Equal.
function ptrEqual(left: number | undefined, right: number | undefined): boolean {
	return left === right;
}

function isReplicaSetNotFoundError(err: Error, name: string): boolean {
	return isNotFoundError(err) || err.message === `replicaset ${name} not found`;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
