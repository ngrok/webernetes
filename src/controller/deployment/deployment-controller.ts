/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import * as k8s from "../../client";
import { getControllerOf } from "../../apimachinery/pkg/apis/meta/v1/controller_ref";
import { labelSelectorAsSelector } from "../../apimachinery/pkg/apis/meta/v1/helpers";
import { everything } from "../../apimachinery/pkg/labels/selector";
import { GroupVersionKind } from "../../apimachinery/pkg/runtime/schema/group_version";
import { defaultDeploymentUniqueLabelKey } from "../../apis/apps/v1/types";
import { hasStatusCause, isNotFoundError } from "../../client/errors";
import {
	newDeploymentLister,
	type DeploymentLister,
} from "../../client-go/listers/apps/v1/deployment";
import {
	newReplicaSetLister,
	type ReplicaSetLister,
} from "../../client-go/listers/apps/v1/replicaset";
import { newPodLister, type PodLister } from "../../client-go/listers/core/v1/pod";
import type { Indexer } from "../../client-go/tools/cache/index";
import { ExplicitKey, newIndexer, splitMetaNamespaceKey } from "../../client-go/tools/cache/store";
import { getClock } from "../../clock-context";
import { defaultTypedControllerRateLimiter } from "../../client-go/util/workqueue/default-rate-limiters";
import {
	newTypedRateLimitingQueueWithConfig,
	type TypedRateLimitingInterface,
} from "../../client-go/util/workqueue/rate-limiting-queue";
import type { EventRecorder } from "../../client-go/tools/record/event";
import { EventRecorderImpl } from "../../cluster/events";
import { retryConflicts } from "../../retry";
import {
	addPodControllerIndexer,
	computeHash,
	compareReplicaSetsByCreationTimestamp,
	filterPodsByOwner,
	filterActiveReplicaSets,
	filterReplicaSets,
	keyFunc,
	RealRSControl,
	type RSControlInterface,
} from "../controller-utils";
import {
	newReplicaSetControllerRefManager,
	recheckDeletionTimestamp,
} from "../controller-ref-manager";
import {
	compareReplicaSetsByRevision,
	deploymentProgressing,
	deploymentTimedOut,
	deploymentComplete,
	equalIgnoreHash,
	failedRSCreateReason,
	findActiveOrLatest,
	findNewReplicaSet,
	findOldReplicaSets,
	foundNewRSReason,
	getAvailableReplicaCountForReplicaSets,
	getActualReplicaCountForReplicaSets,
	getDesiredReplicasAnnotation,
	getReadyReplicaCountForReplicaSets,
	getReplicaCountForReplicaSets,
	getReplicaSetProportion,
	getTerminatingReplicaCountForReplicaSets,
	getDeploymentCondition,
	hasRevisionHistoryLimit,
	hasProgressDeadline,
	getDeploymentsForReplicaSet as getDeploymentsForReplicaSetFromLister,
	isSaturated,
	listReplicaSets,
	maxRevision,
	maxSurge,
	maxUnavailable,
	newRSNewReplicas,
	newDeploymentCondition,
	newReplicaSetReason,
	newRSAvailableReason,
	minimumReplicasAvailable,
	minimumReplicasUnavailable,
	pausedDeployReason,
	removeDeploymentCondition,
	replicaSetToDeploymentCondition,
	replicaSetUpdatedReason,
	replicasAnnotationsNeedUpdate,
	resumedDeployReason,
	revisionAnnotation,
	rsListFromClient,
	setDeploymentCondition,
	setDeploymentRevision,
	setNewReplicaSetAnnotations,
	setReplicasAnnotations,
	timedOutReason,
} from "./util/deployment-util";
import { oldPodsRunning } from "./recreate";
import { deepEqual } from "../../deep-equal";
import type * as context from "../../go/context";
import { cloneSelectorAndAddLabel } from "../../util/labels/labels";

export { oldPodsRunning } from "./recreate";

const controllerKind = new GroupVersionKind("apps", "v1", "Deployment");
const maxRetries = 15;
const namespaceTerminatingCause = "NamespaceTerminating";
const maxRevHistoryLengthInChars = 2000;
const replicaSetNameSeparator = "-";
const dns1123SubdomainMaxLength = 253;

// Models kubernetes/pkg/controller/deployment/deployment_controller.go DeploymentController.
export class DeploymentController {
	private deploymentInformer: k8s.Informer<k8s.V1Deployment> | undefined;
	private replicaSetInformer: k8s.Informer<k8s.V1ReplicaSet> | undefined;
	private podInformer: k8s.Informer<k8s.V1Pod> | undefined;
	readonly queue: TypedRateLimitingInterface<string>;
	readonly deployments = new Map<string, k8s.V1Deployment>();
	readonly replicaSets = new Map<string, k8s.V1ReplicaSet>();
	readonly pods = new Map<string, k8s.V1Pod>();
	readonly dLister: DeploymentLister;
	readonly deploymentIndexer: Indexer<k8s.V1Deployment>;
	readonly rsLister: ReplicaSetLister;
	readonly replicaSetIndexer: Indexer<k8s.V1ReplicaSet>;
	readonly podLister: PodLister;
	readonly podIndexer: Indexer<k8s.V1Pod>;
	readonly eventRecorder: EventRecorder;
	readonly rsControl: RSControlInterface;
	private readonly clock;
	private workerPromise: Promise<void> | undefined;
	syncHandler = async (ctx: context.Context, key: string): Promise<Error | undefined> =>
		await this.syncDeployment(ctx, key);
	enqueueDeployment = (deployment: k8s.V1Deployment): void => this.enqueue(deployment);

	constructor(
		private readonly api: k8s.KubeClient,
		private readonly kubeConfig: k8s.KubeConfig,
		rsControl?: RSControlInterface,
		eventRecorder?: EventRecorder,
	) {
		this.clock = getClock(kubeConfig.options.ctx);
		this.queue = newTypedRateLimitingQueueWithConfig(defaultTypedControllerRateLimiter<string>(), {
			clock: this.clock,
		});
		this.deploymentIndexer = newIndexer(deploymentKeyFunc, {});
		this.replicaSetIndexer = newIndexer(replicaSetKeyFunc, {});
		this.podIndexer = newIndexer(podKeyFunc, {});
		addPodControllerIndexer(this.podIndexer);
		this.dLister = newDeploymentLister(this.deploymentIndexer);
		this.rsLister = newReplicaSetLister(this.replicaSetIndexer);
		this.podLister = newPodLister(this.podIndexer);
		this.eventRecorder =
			eventRecorder ??
			new EventRecorderImpl({
				ctx: kubeConfig.options.ctx,
				api: api.corev1,
				component: "deployment-controller",
			});
		this.rsControl = rsControl ?? new RealRSControl(api, this.eventRecorder);
	}

	async run(ctx: context.Context): Promise<void> {
		await this.startInformers(ctx);
		this.workerPromise = this.worker(ctx);
	}

	async stop(): Promise<void> {
		await this.deploymentInformer?.stop();
		await this.replicaSetInformer?.stop();
		await this.podInformer?.stop();
		await this.queue.shutDown();
		await this.workerPromise;
	}

	private async startInformers(ctx: context.Context): Promise<void> {
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
		this.deploymentInformer.on("add", (deployment) => void this.addDeployment(ctx, deployment));
		this.deploymentInformer.on(
			"update",
			(deployment) => void this.updateDeployment(ctx, deployment),
		);
		this.deploymentInformer.on(
			"delete",
			(deployment) => void this.deleteDeployment(ctx, deployment),
		);
		this.replicaSetInformer.on("add", (replicaSet) => void this.addReplicaSet(ctx, replicaSet));
		this.replicaSetInformer.on("update", (replicaSet) => {
			const [oldReplicaSet] = this.replicaSetIndexer.getByKey(replicaSetKey(replicaSet));
			void this.updateReplicaSet(ctx, oldReplicaSet ?? replicaSet, replicaSet);
		});
		this.replicaSetInformer.on(
			"delete",
			(replicaSet) => void this.deleteReplicaSet(ctx, replicaSet),
		);
		this.podInformer.on("add", (pod) => void this.addPod(ctx, pod));
		this.podInformer.on("update", (pod) => void this.updatePod(ctx, pod));
		this.podInformer.on("delete", (pod) => {
			void this.removePod(pod);
			void this.deletePod(ctx, pod).catch(() => undefined);
		});
		await this.deploymentInformer.start();
		await this.replicaSetInformer.start();
		await this.podInformer.start();
		for (const deployment of this.deploymentIndexer.list()) {
			this.enqueueDeployment(deployment);
		}
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go addDeployment.
	async addDeployment(_ctx: context.Context, deployment: k8s.V1Deployment): Promise<void> {
		const key = deploymentKey(deployment);
		if (key) {
			this.deployments.set(key, deployment);
		}
		await this.deploymentIndexer.add(deployment);
		this.enqueueDeployment(deployment);
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go updateDeployment.
	private async updateDeployment(
		_ctx: context.Context,
		deployment: k8s.V1Deployment,
	): Promise<void> {
		const key = deploymentKey(deployment);
		if (key) {
			this.deployments.set(key, deployment);
		}
		await this.deploymentIndexer.update(deployment);
		this.enqueueDeployment(deployment);
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go deleteDeployment.
	private async deleteDeployment(
		_ctx: context.Context,
		deployment: k8s.V1Deployment,
	): Promise<void> {
		const key = deploymentKey(deployment);
		if (key) {
			this.deployments.delete(key);
		}
		await this.deploymentIndexer.delete(deployment);
		this.enqueueDeployment(deployment);
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go addReplicaSet.
	async addReplicaSet(ctx: context.Context, replicaSet: k8s.V1ReplicaSet): Promise<void> {
		this.replicaSets.set(replicaSetKey(replicaSet), replicaSet);
		await this.replicaSetIndexer.add(replicaSet);
		if (replicaSet.metadata?.deletionTimestamp) {
			await this.deleteReplicaSet(ctx, replicaSet);
			return;
		}
		const controllerRef = getControllerOf(replicaSet);
		if (controllerRef) {
			const deployment = this.resolveControllerRef(replicaSet.metadata?.namespace, controllerRef);
			if (deployment) {
				this.enqueueDeployment(deployment);
			}
			return;
		}
		for (const deployment of this.getDeploymentsForReplicaSet(replicaSet)) {
			this.enqueueDeployment(deployment);
		}
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go updateReplicaSet.
	async updateReplicaSet(
		_ctx: context.Context,
		oldReplicaSet: k8s.V1ReplicaSet,
		curReplicaSet: k8s.V1ReplicaSet,
	): Promise<void> {
		const curRS = curReplicaSet;
		const oldRS = oldReplicaSet;
		if (curRS.metadata?.resourceVersion === oldRS.metadata?.resourceVersion) {
			return;
		}
		this.replicaSets.set(replicaSetKey(curRS), curRS);
		await this.replicaSetIndexer.update(curRS);
		const curControllerRef = getControllerOf(curRS);
		const oldControllerRef = oldRS ? getControllerOf(oldRS) : undefined;
		const controllerRefChanged = !deepEqual(curControllerRef, oldControllerRef);
		if (controllerRefChanged && oldControllerRef) {
			const d = this.resolveControllerRef(oldRS?.metadata?.namespace, oldControllerRef);
			if (d) {
				this.enqueueDeployment(d);
			}
		}
		if (curControllerRef) {
			const d = this.resolveControllerRef(curRS.metadata?.namespace, curControllerRef);
			if (d) {
				this.enqueueDeployment(d);
			}
			return;
		}
		const labelChanged = !deepEqual(curRS.metadata?.labels, oldRS?.metadata?.labels);
		if (labelChanged || controllerRefChanged) {
			for (const deployment of this.getDeploymentsForReplicaSet(curRS)) {
				this.enqueueDeployment(deployment);
			}
		}
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go deleteReplicaSet.
	async deleteReplicaSet(_ctx: context.Context, replicaSet: k8s.V1ReplicaSet): Promise<void> {
		this.replicaSets.delete(replicaSetKey(replicaSet));
		await this.replicaSetIndexer.delete(replicaSet);
		const controller = getControllerOf(replicaSet);
		if (!controller) {
			return;
		}
		const deployment = this.resolveControllerRef(replicaSet.metadata?.namespace, controller);
		if (deployment) {
			this.enqueueDeployment(deployment);
		}
	}

	private async addPod(_ctx: context.Context, pod: k8s.V1Pod): Promise<void> {
		this.pods.set(podKey(pod), pod);
		await this.podIndexer.add(pod);
	}

	private async updatePod(_ctx: context.Context, pod: k8s.V1Pod): Promise<void> {
		this.pods.set(podKey(pod), pod);
		await this.podIndexer.update(pod);
	}

	private async removePod(pod: k8s.V1Pod): Promise<void> {
		this.pods.delete(podKey(pod));
		await this.podIndexer.delete(pod);
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go deletePod.
	async deletePod(ctx: context.Context, pod: k8s.V1Pod): Promise<void> {
		const deployment = this.getDeploymentForPod(pod);
		if (!deployment) {
			return;
		}
		if (deployment.spec?.strategy?.type !== "Recreate") {
			return;
		}
		const [rsList, replicaSetErr] = await listReplicaSets(
			deployment,
			rsListFromClient(this.api.appsv1),
		);
		if (replicaSetErr) {
			return;
		}
		const [podMap, podMapErr] = await this.getPodMapForDeployment(deployment, rsList);
		if (podMapErr) {
			return;
		}
		let numPods = 0;
		for (const podList of podMap.values()) {
			numPods += podList.length;
		}
		if (numPods === 0) {
			this.enqueueDeployment(deployment);
		}
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go enqueue.
	private enqueue(deployment: k8s.V1Deployment): void {
		const [key, err] = keyFunc(deployment);
		if (err) {
			return;
		}
		this.queue.add(key);
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go enqueueRateLimited.
	private async enqueueRateLimited(deployment: k8s.V1Deployment): Promise<void> {
		const [key, err] = keyFunc(deployment);
		if (err) {
			return;
		}
		await this.queue.addRateLimited(key);
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go enqueueAfter.
	private async enqueueAfter(deployment: k8s.V1Deployment, afterMs: number): Promise<void> {
		const [key, err] = keyFunc(deployment);
		if (err) {
			return;
		}
		await this.queue.addAfter(key, afterMs);
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go worker.
	private async worker(ctx: context.Context): Promise<void> {
		while (await this.processNextWorkItem(ctx)) {}
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go processNextWorkItem.
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
			await this.handleErr(err, key);
		} finally {
			this.queue.done(key);
		}
		return true;
	}

	private async handleErr(err: Error | undefined, key: string): Promise<void> {
		if (!err || hasStatusCause(err, namespaceTerminatingCause)) {
			this.queue.forget(key);
			return;
		}
		if (this.queue.numRequeues(key) < maxRetries) {
			await this.queue.addRateLimited(key);
			return;
		}
		this.queue.forget(key);
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go syncDeployment.
	async syncDeployment(ctx: context.Context, key: string): Promise<Error | undefined> {
		try {
			const [namespace, name, keyErr] = splitMetaNamespaceKey(key);
			if (keyErr) {
				return keyErr;
			}
			const [deployment, deploymentErr] = this.dLister.deployments(namespace).get(name);
			if (deploymentErr) {
				if (isNotFoundError(deploymentErr)) {
					return undefined;
				}
				return deploymentErr;
			}
			if (!deployment) {
				return undefined;
			}

			const d = structuredClone(deployment);
			if (deepEqual(d.spec?.selector ?? {}, {})) {
				await this.eventRecorder.eventf(
					d,
					"Warning",
					"SelectingAll",
					"This deployment is selecting all pods. A non-empty selector is required.",
				);
				if ((d.status?.observedGeneration ?? 0) < (d.metadata?.generation ?? 0)) {
					d.status ??= {};
					d.status.observedGeneration = d.metadata?.generation;
					await this.updateDeploymentStatus(ctx, d);
				}
				return undefined;
			}
			const [rsList, getReplicaSetsErr] = await this.getReplicaSetsForDeployment(ctx, d);
			if (getReplicaSetsErr) {
				return getReplicaSetsErr;
			}
			const [podMap, podMapErr] = await this.getPodMapForDeployment(d, rsList);
			if (podMapErr) {
				return podMapErr;
			}
			if (d.metadata?.deletionTimestamp) {
				return await this.syncStatusOnly(ctx, d, rsList);
			}

			const pausedErr = await this.checkPausedConditions(ctx, d);
			if (pausedErr) {
				return pausedErr;
			}
			if (d.spec?.paused) {
				return await this.sync(ctx, d, rsList);
			}

			// TODO(samwho): upstream does rollback stuff here, I've opted to cut it
			// for now.

			const [scalingEvent, scalingErr] = await this.isScalingEvent(ctx, d, rsList);
			if (scalingErr) {
				return scalingErr;
			}
			if (scalingEvent) {
				return await this.sync(ctx, d, rsList);
			}
			switch (d.spec?.strategy?.type) {
				case "Recreate":
					return await this.rolloutRecreate(ctx, d, rsList, podMap);
				case "RollingUpdate":
				case undefined:
					return await this.rolloutRolling(ctx, d, rsList);
				default:
					return new Error(`unexpected deployment strategy type: ${d.spec?.strategy?.type}`);
			}
		} catch (error) {
			return error instanceof Error ? error : new Error(String(error));
		}
	}

	// Models kubernetes/pkg/controller/deployment/sync.go syncStatusOnly.
	private async syncStatusOnly(
		ctx: context.Context,
		d: k8s.V1Deployment,
		rsList: k8s.V1ReplicaSet[],
	): Promise<Error | undefined> {
		const [newRS, oldRSs, err] = await this.getAllReplicaSetsAndSyncRevision(ctx, d, rsList, false);
		if (err) {
			return err;
		}
		return await this.syncDeploymentStatus(
			ctx,
			[...oldRSs, newRS].filter(
				(replicaSet): replicaSet is k8s.V1ReplicaSet => replicaSet !== undefined,
			),
			newRS,
			d,
		);
	}

	// Models kubernetes/pkg/controller/deployment/sync.go sync.
	private async sync(
		ctx: context.Context,
		d: k8s.V1Deployment,
		rsList: k8s.V1ReplicaSet[],
	): Promise<Error | undefined> {
		const [newRS, oldRSs, err] = await this.getAllReplicaSetsAndSyncRevision(ctx, d, rsList, false);
		if (err) {
			return err;
		}
		const scaleErr = await this.scale(ctx, d, newRS, oldRSs);
		if (scaleErr) {
			return scaleErr;
		}
		if (d.spec?.paused /* TODO(samwho): rollback support here */) {
			const cleanupErr = await this.cleanupDeployment(ctx, oldRSs, d);
			if (cleanupErr) {
				return cleanupErr;
			}
		}
		return await this.syncDeploymentStatus(
			ctx,
			[...oldRSs, newRS].filter(
				(replicaSet): replicaSet is k8s.V1ReplicaSet => replicaSet !== undefined,
			),
			newRS,
			d,
		);
	}

	// Models kubernetes/pkg/controller/deployment/sync.go checkPausedConditions.
	private async checkPausedConditions(
		ctx: context.Context,
		d: k8s.V1Deployment,
	): Promise<Error | undefined> {
		if (!hasProgressDeadline(d)) {
			return undefined;
		}
		d.status ??= {};
		const condition = getDeploymentCondition(d.status, "Progressing");
		if (condition?.reason === timedOutReason) {
			return undefined;
		}
		const pausedCondExists = condition?.reason === pausedDeployReason;
		let needsUpdate = false;
		if (d.spec?.paused && !pausedCondExists) {
			setDeploymentCondition(
				d.status,
				newDeploymentCondition(
					this.clock.now(),
					"Progressing",
					"Unknown",
					pausedDeployReason,
					"Deployment is paused",
				),
			);
			needsUpdate = true;
		} else if (!d.spec?.paused && pausedCondExists) {
			setDeploymentCondition(
				d.status,
				newDeploymentCondition(
					this.clock.now(),
					"Progressing",
					"Unknown",
					resumedDeployReason,
					"Deployment is resumed",
				),
			);
			needsUpdate = true;
		}
		if (!needsUpdate) {
			return undefined;
		}
		return await this.updateDeploymentStatus(ctx, d);
	}

	// Models kubernetes/pkg/controller/deployment/sync.go isScalingEvent.
	private async isScalingEvent(
		ctx: context.Context,
		d: k8s.V1Deployment,
		rsList: k8s.V1ReplicaSet[],
	): Promise<[scalingEvent: boolean, err: Error | undefined]> {
		const [newRS, oldRSs, err] = await this.getAllReplicaSetsAndSyncRevision(ctx, d, rsList, false);
		if (err) {
			return [false, err];
		}
		const allRSs = [...oldRSs, newRS].filter(
			(replicaSet): replicaSet is k8s.V1ReplicaSet => replicaSet !== undefined,
		);
		for (const rs of filterActiveReplicaSets(allRSs)) {
			const [desired, ok] = getDesiredReplicasAnnotation(rs);
			if (!ok) {
				continue;
			}
			if (desired !== (d.spec?.replicas ?? 1)) {
				return [true, undefined];
			}
		}
		return [false, undefined];
	}

	// Models kubernetes/pkg/controller/deployment/sync.go scale.
	private async scale(
		ctx: context.Context,
		deployment: k8s.V1Deployment,
		newRS: k8s.V1ReplicaSet | undefined,
		oldRSs: k8s.V1ReplicaSet[],
	): Promise<Error | undefined> {
		const activeOrLatest = findActiveOrLatest(newRS, oldRSs);
		if (activeOrLatest) {
			if ((activeOrLatest.spec?.replicas ?? 1) === (deployment.spec?.replicas ?? 1)) {
				return undefined;
			}
			const [, , err] = await this.scaleReplicaSet(
				ctx,
				activeOrLatest,
				deployment.spec?.replicas ?? 1,
				deployment,
				false,
			);
			return err;
		}
		if (isSaturated(deployment, newRS)) {
			for (const oldReplicaSet of filterActiveReplicaSets(oldRSs)) {
				const [, , err] = await this.scaleReplicaSet(ctx, oldReplicaSet, 0, deployment, false);
				if (err) {
					return err;
				}
			}
			return undefined;
		}
		if (deployment.spec?.strategy?.type !== "RollingUpdate") {
			return undefined;
		}
		const allRSs = filterActiveReplicaSets(
			[...oldRSs, newRS].filter(
				(replicaSet): replicaSet is k8s.V1ReplicaSet => replicaSet !== undefined,
			),
		);
		const allRSsReplicas = getReplicaCountForReplicaSets(allRSs);
		let allowedSize = 0;
		if ((deployment.spec?.replicas ?? 1) > 0) {
			allowedSize = (deployment.spec?.replicas ?? 1) + maxSurge(deployment);
		}
		const deploymentReplicasToAdd = allowedSize - allRSsReplicas;
		if (deploymentReplicasToAdd > 0) {
			allRSs.sort(compareReplicaSetsBySizeNewer);
		} else if (deploymentReplicasToAdd < 0) {
			allRSs.sort(compareReplicaSetsBySizeOlder);
		}
		let deploymentReplicasAdded = 0;
		const nameToSize = new Map<string, number>();
		for (const rs of allRSs) {
			if (deploymentReplicasToAdd !== 0) {
				const proportion = getReplicaSetProportion(
					rs,
					deployment,
					deploymentReplicasToAdd,
					deploymentReplicasAdded,
				);
				nameToSize.set(rs.metadata?.name ?? "", (rs.spec?.replicas ?? 1) + proportion);
				deploymentReplicasAdded += proportion;
			} else {
				nameToSize.set(rs.metadata?.name ?? "", rs.spec?.replicas ?? 1);
			}
		}
		for (let i = 0; i < allRSs.length; i++) {
			const rs = allRSs[i];
			const name = rs.metadata?.name ?? "";
			if (i === 0 && deploymentReplicasToAdd !== 0) {
				const leftover = deploymentReplicasToAdd - deploymentReplicasAdded;
				nameToSize.set(name, Math.max((nameToSize.get(name) ?? 0) + leftover, 0));
			}
			const [, , err] = await this.scaleReplicaSet(
				ctx,
				rs,
				nameToSize.get(name) ?? 0,
				deployment,
				true,
			);
			if (err) {
				return err;
			}
		}
		return undefined;
	}

	// Models kubernetes/pkg/controller/deployment/recreate.go rolloutRecreate.
	private async rolloutRecreate(
		ctx: context.Context,
		d: k8s.V1Deployment,
		rsList: k8s.V1ReplicaSet[],
		podMap: Map<string, k8s.V1Pod[]>,
	): Promise<Error | undefined> {
		let [newRS, oldRSs, err] = await this.getAllReplicaSetsAndSyncRevision(ctx, d, rsList, false);
		if (err) {
			return err;
		}
		let allRSs = [...oldRSs, newRS].filter(
			(replicaSet): replicaSet is k8s.V1ReplicaSet => replicaSet !== undefined,
		);
		const [scaledDown, scaledDownErr] = await this.scaleDownOldReplicaSetsForRecreate(
			ctx,
			filterActiveReplicaSets(oldRSs),
			d,
		);
		if (scaledDownErr) {
			return scaledDownErr;
		}
		if (scaledDown) {
			return await this.syncRolloutStatus(ctx, allRSs, newRS, d);
		}
		if (oldPodsRunning(newRS, oldRSs, podMap)) {
			return await this.syncRolloutStatus(ctx, allRSs, newRS, d);
		}
		if (!newRS) {
			[newRS, oldRSs, err] = await this.getAllReplicaSetsAndSyncRevision(ctx, d, rsList, true);
			if (err) {
				return err;
			}
			allRSs = [...oldRSs, newRS].filter(
				(replicaSet): replicaSet is k8s.V1ReplicaSet => replicaSet !== undefined,
			);
		}
		if (!newRS) {
			return undefined;
		}
		const [, scaleUpErr] = await this.scaleUpNewReplicaSetForRecreate(ctx, newRS, d);
		if (scaleUpErr) {
			return scaleUpErr;
		}
		if (deploymentComplete(d, d.status ?? {})) {
			const cleanupErr = await this.cleanupDeployment(ctx, oldRSs, d);
			if (cleanupErr) {
				return cleanupErr;
			}
		}
		return await this.syncRolloutStatus(ctx, allRSs, newRS, d);
	}

	// Models kubernetes/pkg/controller/deployment/rolling.go rolloutRolling.
	private async rolloutRolling(
		ctx: context.Context,
		d: k8s.V1Deployment,
		rsList: k8s.V1ReplicaSet[],
	): Promise<Error | undefined> {
		const [nweRS, oldRSs, err] = await this.getAllReplicaSetsAndSyncRevision(ctx, d, rsList, true);
		if (err) {
			return err;
		}
		if (!nweRS) {
			return undefined;
		}
		const allRSs = [...oldRSs, nweRS];
		const [scaledUp, scaleUpErr] = await this.reconcileNewReplicaSet(ctx, allRSs, nweRS, d);
		if (scaleUpErr) {
			return scaleUpErr;
		}
		if (scaledUp) {
			return await this.syncRolloutStatus(ctx, allRSs, nweRS, d);
		}
		const activeOldReplicaSets = filterActiveReplicaSets(oldRSs);
		const [scaledDown, scaleDownErr] = await this.reconcileOldReplicaSets(
			ctx,
			allRSs,
			activeOldReplicaSets,
			nweRS,
			d,
		);
		if (scaleDownErr) {
			return scaleDownErr;
		}
		if (scaledDown) {
			return await this.syncRolloutStatus(ctx, allRSs, nweRS, d);
		}

		if (deploymentComplete(d, d.status ?? {})) {
			const cleanupErr = await this.cleanupDeployment(ctx, oldRSs, d);
			if (cleanupErr) {
				return cleanupErr;
			}
		}

		return await this.syncRolloutStatus(ctx, allRSs, nweRS, d);
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go getReplicaSetsForDeployment.
	async getReplicaSetsForDeployment(
		ctx: context.Context,
		d: k8s.V1Deployment,
	): Promise<[k8s.V1ReplicaSet[], Error | undefined]> {
		try {
			const namespace = d.metadata?.namespace ?? "default";
			const [rsList, listErr] = this.rsLister.replicaSets(namespace).list(everything());
			if (listErr) {
				return [[], listErr];
			}
			const [deploymentSelector, selectorErr] = labelSelectorAsSelector(d.spec?.selector);
			if (selectorErr || !deploymentSelector) {
				return [[], selectorErr ?? new Error("deployment has no selector")];
			}
			const canAdoptFunc = recheckDeletionTimestamp(async () => {
				try {
					const fresh = await this.api.appsv1.readNamespacedDeployment({
						name: d.metadata?.name ?? "",
						namespace,
					});
					if (fresh.metadata?.uid !== d.metadata?.uid) {
						return [
							undefined,
							new Error(
								`original Deployment ${d.metadata?.namespace}/${d.metadata?.name} is gone: got uid ${fresh.metadata?.uid}, wanted ${d.metadata?.uid}`,
							),
						];
					}
					return [fresh, undefined];
				} catch (error) {
					return [undefined, error instanceof Error ? error : new Error(String(error))];
				}
			});
			const cm = newReplicaSetControllerRefManager(
				this.rsControl,
				d,
				deploymentSelector,
				controllerKind,
				canAdoptFunc,
			);
			return await cm.claimReplicaSets(ctx, rsList);
		} catch (error) {
			return [[], error instanceof Error ? error : new Error(String(error))];
		}
	}

	// Models kubernetes/pkg/controller/deployment/sync.go getAllReplicaSetsAndSyncRevision.
	private async getAllReplicaSetsAndSyncRevision(
		ctx: context.Context,
		d: k8s.V1Deployment,
		rsList: k8s.V1ReplicaSet[],
		createIfNotExisted: boolean,
	): Promise<
		[
			newReplicaSet: k8s.V1ReplicaSet | undefined,
			oldReplicaSets: k8s.V1ReplicaSet[],
			err: Error | undefined,
		]
	> {
		const [, allOldRSs] = findOldReplicaSets(d, rsList);
		const [newRS, err] = await this.getNewReplicaSet(ctx, d, rsList, allOldRSs, createIfNotExisted);
		if (err) {
			return [undefined, [], err];
		}
		return [newRS, allOldRSs, undefined];
	}

	// Models kubernetes/pkg/controller/deployment/sync.go getNewReplicaSet.
	private async getNewReplicaSet(
		ctx: context.Context,
		d: k8s.V1Deployment,
		rsList: k8s.V1ReplicaSet[],
		oldRSs: k8s.V1ReplicaSet[],
		createIfNotExisted: boolean,
	): Promise<[replicaSet: k8s.V1ReplicaSet | undefined, err: Error | undefined]> {
		const existingNewRS = findNewReplicaSet(d, rsList);
		const newRevision = String(maxRevision(oldRSs) + 1);
		if (existingNewRS) {
			const rsCopy = structuredClone(existingNewRS);
			const annotationsUpdated = setNewReplicaSetAnnotations(
				d,
				rsCopy,
				newRevision,
				true,
				maxRevHistoryLengthInChars,
			);
			const minReadySecondsNeedsUpdate =
				(rsCopy.spec?.minReadySeconds ?? 0) !== (d.spec?.minReadySeconds ?? 0);
			if (annotationsUpdated || minReadySecondsNeedsUpdate) {
				rsCopy.spec ??= {
					selector: d.spec?.selector ?? {},
				};
				rsCopy.spec.minReadySeconds = d.spec?.minReadySeconds;
				const [updated, err] = await this.updateReplicaSetObject(ctx, rsCopy, d);
				return [updated, err];
			}

			d.status ??= {};
			let needsUpdate = setDeploymentRevision(
				d,
				rsCopy.metadata?.annotations?.[revisionAnnotation] ?? "",
			);
			const cond = getDeploymentCondition(d.status, "Progressing");
			if (hasProgressDeadline(d) && !cond) {
				setDeploymentCondition(
					d.status,
					newDeploymentCondition(
						this.clock.now(),
						"Progressing",
						"True",
						foundNewRSReason,
						`Found new replica set "${rsCopy.metadata?.name ?? ""}"`,
					),
				);
				needsUpdate = true;
			}
			if (needsUpdate) {
				const updateErr = await this.updateDeploymentStatus(ctx, d);
				if (updateErr) {
					return [undefined, updateErr];
				}
			}
			return [rsCopy, undefined];
		}

		if (!createIfNotExisted) {
			return [undefined, undefined];
		}

		const newRSTemplate = structuredClone(d.spec?.template ?? {});
		const podTemplateSpecHash = computeHash(newRSTemplate, d.status?.collisionCount);
		newRSTemplate.metadata ??= {};
		newRSTemplate.metadata.labels ??= {};
		newRSTemplate.metadata.labels[defaultDeploymentUniqueLabelKey] = podTemplateSpecHash;
		const newRSSelector = cloneSelectorAndAddLabel(
			d.spec?.selector ?? {},
			defaultDeploymentUniqueLabelKey,
			podTemplateSpecHash,
		);
		const newRS: k8s.V1ReplicaSet = {
			apiVersion: "apps/v1",
			kind: "ReplicaSet",
			metadata: {
				name: generateReplicaSetName(d.metadata?.name ?? "", podTemplateSpecHash),
				namespace: d.metadata?.namespace ?? "default",
				ownerReferences: [ownerReference(d)],
				labels: newRSTemplate.metadata.labels,
			},
			spec: {
				replicas: 0,
				minReadySeconds: d.spec?.minReadySeconds,
				selector: newRSSelector,
				template: newRSTemplate,
			},
		};
		const [newReplicasCount, replicasErr] = newRSNewReplicas(d, [...oldRSs, newRS], newRS);
		if (replicasErr) {
			return [undefined, replicasErr];
		}
		if (!newRS.spec) {
			return [undefined, new Error("new replica set does not have spec")];
		}
		newRS.spec.replicas = newReplicasCount;
		setNewReplicaSetAnnotations(d, newRS, newRevision, false, maxRevHistoryLengthInChars);

		let alreadyExists = false;
		let [createdRS, createErr] = await this.createReplicaSet(ctx, d, newRS);
		switch (true) {
			case createErr !== undefined && isAlreadyExistsError(createErr): {
				alreadyExists = true;
				const [rs, rsErr] = this.rsLister
					.replicaSets(newRS.metadata?.namespace ?? "default")
					.get(newRS.metadata?.name ?? "");
				if (rsErr) {
					return [undefined, rsErr];
				}
				const controllerRef = rs ? getControllerOf(rs) : undefined;
				if (
					controllerRef &&
					controllerRef.uid === d.metadata?.uid &&
					equalIgnoreHash(d.spec?.template, rs?.spec?.template)
				) {
					createdRS = rs;
					createErr = undefined;
				} else {
					d.status ??= {};
					d.status.collisionCount = (d.status.collisionCount ?? 0) + 1;
					await this.updateDeploymentStatus(ctx, d);
					return [undefined, createErr];
				}
				break;
			}
			case createErr !== undefined && hasStatusCause(createErr, namespaceTerminatingCause):
				return [undefined, createErr];
			case createErr !== undefined: {
				const message = `Failed to create new replica set "${newRS.metadata?.name ?? ""}": ${createErr}`;
				if (hasProgressDeadline(d)) {
					d.status ??= {};
					setDeploymentCondition(
						d.status,
						newDeploymentCondition(
							this.clock.now(),
							"Progressing",
							"False",
							failedRSCreateReason,
							message,
						),
					);
					await this.updateDeploymentStatus(ctx, d);
				}
				await this.eventRecorder.eventf(d, "Warning", failedRSCreateReason, "%s", message);
				return [undefined, createErr];
			}
		}
		if (createdRS && !alreadyExists && newReplicasCount > 0) {
			await this.eventRecorder.eventf(
				d,
				"Normal",
				"ScalingReplicaSet",
				"Scaled up replica set %s from 0 to %d",
				createdRS.metadata?.name ?? "",
				newReplicasCount,
			);
		}

		d.status ??= {};
		let needsUpdate = setDeploymentRevision(d, newRevision);
		if (!alreadyExists && hasProgressDeadline(d)) {
			setDeploymentCondition(
				d.status,
				newDeploymentCondition(
					this.clock.now(),
					"Progressing",
					"True",
					newReplicaSetReason,
					`Created new replica set "${createdRS?.metadata?.name ?? ""}"`,
				),
			);
			needsUpdate = true;
		}
		if (needsUpdate) {
			const err = await this.updateDeploymentStatus(ctx, d);
			if (err) {
				return [createdRS, err];
			}
		}
		return [createdRS, undefined];
	}

	// Models kubernetes/pkg/controller/deployment/sync.go scaleReplicaSet.
	private async scaleReplicaSet(
		_ctx: context.Context,
		rs: k8s.V1ReplicaSet,
		newScale: number,
		deployment: k8s.V1Deployment,
		forceUpdate: boolean,
	): Promise<[scaled: boolean, replicaSet: k8s.V1ReplicaSet | undefined, err: Error | undefined]> {
		const name = rs.metadata?.name;
		const namespace = rs.metadata?.namespace ?? deployment.metadata?.namespace ?? "default";
		if (!name) {
			return [false, undefined, undefined];
		}
		rs.spec ??= {
			selector: deployment.spec?.selector ?? {},
		};
		if (!forceUpdate && (rs.spec.replicas ?? 1) === newScale) {
			return [false, rs, undefined];
		}

		const sizeNeedsUpdate = (rs.spec.replicas ?? 1) !== newScale;
		const annotationsNeedUpdate = replicasAnnotationsNeedUpdate(
			rs,
			deployment.spec?.replicas ?? 1,
			(deployment.spec?.replicas ?? 1) + maxSurge(deployment),
		);

		let scaled = false;
		let err: Error | undefined;
		if (sizeNeedsUpdate || annotationsNeedUpdate) {
			const oldScale = rs.spec.replicas ?? 1;
			const rsCopy = structuredClone(rs);
			rsCopy.spec ??= {
				selector: deployment.spec?.selector ?? {},
			};
			rsCopy.spec.replicas = newScale;
			setReplicasAnnotations(
				rsCopy,
				deployment.spec?.replicas ?? 1,
				(deployment.spec?.replicas ?? 1) + maxSurge(deployment),
			);
			try {
				rs = await this.api.appsv1.replaceNamespacedReplicaSet({
					name,
					namespace,
					body: rsCopy,
				});
				this.replicaSets.set(replicaSetKey(rs), rs);
				await this.replicaSetIndexer.update(rs);
			} catch (error) {
				err = error instanceof Error ? error : new Error(String(error));
			}
			if (!err && sizeNeedsUpdate) {
				const scalingOperation = oldScale < newScale ? "up" : "down";
				scaled = true;
				await this.eventRecorder.eventf(
					deployment,
					"Normal",
					"ScalingReplicaSet",
					"Scaled %s replica set %s from %d to %d",
					scalingOperation,
					name,
					oldScale,
					newScale,
				);
			}
		}
		return [scaled, rs, err];
	}

	private async updateReplicaSetObject(
		ctx: context.Context,
		replicaSet: k8s.V1ReplicaSet,
		deployment: k8s.V1Deployment,
	): Promise<[replicaSet: k8s.V1ReplicaSet | undefined, err: Error | undefined]> {
		const name = replicaSet.metadata?.name;
		const namespace = replicaSet.metadata?.namespace ?? deployment.metadata?.namespace ?? "default";
		if (!name) {
			return [undefined, undefined];
		}
		try {
			let updatedReplicaSet: k8s.V1ReplicaSet | undefined;
			await retryConflicts(ctx, async () => {
				updatedReplicaSet = await this.api.appsv1.replaceNamespacedReplicaSet({
					name,
					namespace,
					body: replicaSet,
				});
				this.replicaSets.set(replicaSetKey(updatedReplicaSet), updatedReplicaSet);
				await this.replicaSetIndexer.update(updatedReplicaSet);
			});
			return [updatedReplicaSet, undefined];
		} catch (error) {
			return [undefined, error instanceof Error ? error : new Error(String(error))];
		}
	}

	private async createReplicaSet(
		_ctx: context.Context,
		deployment: k8s.V1Deployment,
		replicaSet: k8s.V1ReplicaSet,
	): Promise<[replicaSet: k8s.V1ReplicaSet | undefined, err: Error | undefined]> {
		const namespace = deployment.metadata?.namespace ?? "default";
		try {
			const created = await this.api.appsv1.createNamespacedReplicaSet({
				namespace,
				body: replicaSet,
			});
			this.replicaSets.set(replicaSetKey(created), created);
			await this.replicaSetIndexer.add(created);
			return [created, undefined];
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			return [undefined, err];
		}
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go getDeploymentsForReplicaSet.
	private getDeploymentsForReplicaSet(replicaSet: k8s.V1ReplicaSet): k8s.V1Deployment[] {
		const [deployments, err] = getDeploymentsForReplicaSetFromLister(this.dLister, replicaSet);
		if (err || deployments.length === 0) {
			return [];
		}
		return deployments;
	}

	private async updateDeploymentStatus(
		ctx: context.Context,
		deployment: k8s.V1Deployment,
	): Promise<Error | undefined> {
		const name = deployment.metadata?.name;
		const namespace = deployment.metadata?.namespace ?? "default";
		if (!name) {
			return undefined;
		}
		try {
			await retryConflicts(ctx, async () => {
				await this.api.appsv1.replaceNamespacedDeploymentStatus({
					name,
					namespace,
					body: deployment,
				});
				this.deployments.set(deploymentKey(deployment) ?? "", deployment);
				await this.deploymentIndexer.update(deployment);
			});
		} catch (error) {
			return error instanceof Error ? error : new Error(String(error));
		}
		return undefined;
	}

	// Models kubernetes/pkg/controller/deployment/progress.go syncRolloutStatus.
	private async syncRolloutStatus(
		ctx: context.Context,
		allRSs: k8s.V1ReplicaSet[],
		newRS: k8s.V1ReplicaSet | undefined,
		d: k8s.V1Deployment,
	): Promise<Error | undefined> {
		const newStatus = this.calculateStatus(allRSs, newRS, d);
		if (!hasProgressDeadline(d)) {
			removeDeploymentCondition(newStatus, "Progressing");
		}

		const currentCond = getDeploymentCondition(d.status, "Progressing");
		const isCompleteDeployment =
			(newStatus.replicas ?? 0) === (newStatus.updatedReplicas ?? 0) &&
			currentCond?.reason === newRSAvailableReason;
		if (hasProgressDeadline(d) && !isCompleteDeployment) {
			if (deploymentComplete(d, newStatus)) {
				const message = newRS
					? `ReplicaSet "${newRS.metadata?.name ?? ""}" has successfully progressed.`
					: `Deployment "${d.metadata?.name ?? ""}" has successfully progressed.`;
				setDeploymentCondition(
					newStatus,
					newDeploymentCondition(
						this.clock.now(),
						"Progressing",
						"True",
						newRSAvailableReason,
						message,
					),
				);
			} else if (deploymentProgressing(d, newStatus)) {
				const message = newRS
					? `ReplicaSet "${newRS.metadata?.name ?? ""}" is progressing.`
					: `Deployment "${d.metadata?.name ?? ""}" is progressing.`;
				const condition = newDeploymentCondition(
					this.clock.now(),
					"Progressing",
					"True",
					replicaSetUpdatedReason,
					message,
				);
				if (currentCond) {
					if (currentCond.status === "True") {
						condition.lastTransitionTime = currentCond.lastTransitionTime;
					}
					removeDeploymentCondition(newStatus, "Progressing");
				}
				setDeploymentCondition(newStatus, condition);
			} else if (deploymentTimedOut(ctx, d, newStatus)) {
				const message = newRS
					? `ReplicaSet "${newRS.metadata?.name ?? ""}" has timed out progressing.`
					: `Deployment "${d.metadata?.name ?? ""}" has timed out progressing.`;
				setDeploymentCondition(
					newStatus,
					newDeploymentCondition(this.clock.now(), "Progressing", "False", timedOutReason, message),
				);
			}
		}

		const replicaFailureCond = this.getReplicaFailures(allRSs, newRS);
		if (replicaFailureCond.length > 0) {
			setDeploymentCondition(newStatus, replicaFailureCond[0]);
		} else {
			removeDeploymentCondition(newStatus, "ReplicaFailure");
		}

		if (deepEqual(d.status ?? {}, newStatus)) {
			this.requeueStuckDeployment(d, newStatus);
			return undefined;
		}
		d.status = newStatus;
		return await this.updateDeploymentStatus(ctx, d);
	}

	// Models kubernetes/pkg/controller/deployment/sync.go syncDeploymentStatus.
	private async syncDeploymentStatus(
		ctx: context.Context,
		allReplicaSets: k8s.V1ReplicaSet[],
		newReplicaSet: k8s.V1ReplicaSet | undefined,
		deployment: k8s.V1Deployment,
	): Promise<Error | undefined> {
		const newStatus = this.calculateStatus(allReplicaSets, newReplicaSet, deployment);
		if (deepEqual(deployment.status ?? {}, newStatus)) {
			return undefined;
		}
		deployment.status = newStatus;
		return await this.updateDeploymentStatus(ctx, deployment);
	}

	// Models kubernetes/pkg/controller/deployment/sync.go calculateStatus.
	private calculateStatus(
		allReplicaSets: k8s.V1ReplicaSet[],
		newReplicaSet: k8s.V1ReplicaSet | undefined,
		deployment: k8s.V1Deployment,
	): k8s.V1DeploymentStatus {
		const availableReplicas = getAvailableReplicaCountForReplicaSets(allReplicaSets);
		const totalReplicas = getReplicaCountForReplicaSets(allReplicaSets);
		const unavailableReplicas = Math.max(totalReplicas - availableReplicas, 0);
		const status: k8s.V1DeploymentStatus = {
			observedGeneration: deployment.metadata?.generation,
			replicas: getActualReplicaCountForReplicaSets(allReplicaSets),
			updatedReplicas: newReplicaSet ? getActualReplicaCountForReplicaSets([newReplicaSet]) : 0,
			readyReplicas: getReadyReplicaCountForReplicaSets(allReplicaSets),
			availableReplicas,
			unavailableReplicas,
			collisionCount: deployment.status?.collisionCount,
			terminatingReplicas: getTerminatingReplicaCountForReplicaSets(allReplicaSets),
			conditions: structuredClone(deployment.status?.conditions ?? []),
		};
		if (availableReplicas >= (deployment.spec?.replicas ?? 1) - maxUnavailable(deployment)) {
			setDeploymentCondition(
				status,
				newDeploymentCondition(
					this.clock.now(),
					"Available",
					"True",
					minimumReplicasAvailable,
					"Deployment has minimum availability.",
				),
			);
		} else {
			setDeploymentCondition(
				status,
				newDeploymentCondition(
					this.clock.now(),
					"Available",
					"False",
					minimumReplicasUnavailable,
					"Deployment does not have minimum availability.",
				),
			);
		}
		return status;
	}

	// Models kubernetes/pkg/controller/deployment/progress.go getReplicaFailures.
	private getReplicaFailures(
		allReplicaSets: k8s.V1ReplicaSet[],
		newReplicaSet: k8s.V1ReplicaSet | undefined,
	): k8s.V1DeploymentCondition[] {
		let conditions: k8s.V1DeploymentCondition[] = [];
		if (newReplicaSet) {
			conditions = (newReplicaSet.status?.conditions ?? [])
				.filter((condition) => condition.type === "ReplicaFailure")
				.map(replicaSetToDeploymentCondition);
		}
		if (conditions.length > 0) {
			return conditions;
		}
		for (const replicaSet of allReplicaSets) {
			for (const condition of replicaSet.status?.conditions ?? []) {
				if (condition.type === "ReplicaFailure") {
					conditions.push(replicaSetToDeploymentCondition(condition));
				}
			}
		}
		return conditions;
	}

	// Models kubernetes/pkg/controller/deployment/progress.go requeueStuckDeployment.
	private requeueStuckDeployment(
		deployment: k8s.V1Deployment,
		newStatus: k8s.V1DeploymentStatus,
	): number {
		const currentCond = getDeploymentCondition(deployment.status, "Progressing");
		if (!hasProgressDeadline(deployment) || !currentCond) {
			return -1;
		}
		if (deploymentComplete(deployment, newStatus) || currentCond.reason === timedOutReason) {
			return -1;
		}
		if (!currentCond.lastUpdateTime) {
			return -1;
		}
		const after =
			currentCond.lastUpdateTime.getTime() +
			(deployment.spec?.progressDeadlineSeconds ?? 0) * 1000 -
			this.clock.nowMs();
		if (after < 1000) {
			void this.enqueueRateLimited(deployment);
			return 0;
		}
		void this.enqueueAfter(deployment, after + 1000);
		return after;
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go getPodMapForDeployment.
	async getPodMapForDeployment(
		_deployment: k8s.V1Deployment,
		replicaSets: k8s.V1ReplicaSet[],
	): Promise<[podMap: Map<string, k8s.V1Pod[]>, err: Error | undefined]> {
		const podMap = new Map<string, k8s.V1Pod[]>();
		for (const replicaSet of replicaSets) {
			const uid = replicaSet.metadata?.uid;
			if (uid) {
				podMap.set(uid, []);
			}
		}
		for (const replicaSet of replicaSets) {
			const uid = replicaSet.metadata?.uid;
			if (!uid) {
				continue;
			}
			const [pods, err] = filterPodsByOwner(
				this.podIndexer,
				replicaSet.metadata ?? {},
				"ReplicaSet",
				false,
			);
			if (err) {
				return [podMap, err];
			}
			podMap.set(uid, pods);
		}
		return [podMap, undefined];
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go getDeploymentForPod.
	private getDeploymentForPod(pod: k8s.V1Pod): k8s.V1Deployment | undefined {
		let controller = getControllerOf(pod);
		if (!controller || controller.kind !== "ReplicaSet") {
			return undefined;
		}
		const [replicaSet, replicaSetErr] = this.rsLister
			.replicaSets(pod.metadata?.namespace ?? "default")
			.get(controller.name ?? "");
		if (replicaSetErr || !replicaSet || replicaSet.metadata?.uid !== controller.uid) {
			return undefined;
		}
		controller = getControllerOf(replicaSet);
		if (!controller) {
			return undefined;
		}
		return this.resolveControllerRef(replicaSet.metadata?.namespace, controller);
	}

	// Models kubernetes/pkg/controller/deployment/deployment_controller.go resolveControllerRef.
	private resolveControllerRef(
		namespace: string | undefined,
		controllerRef: k8s.V1OwnerReference,
	): k8s.V1Deployment | undefined {
		if (controllerRef.kind !== controllerKind.kind) {
			return undefined;
		}
		const [deployment, err] = this.dLister
			.deployments(namespace ?? "default")
			.get(controllerRef.name ?? "");
		if (err || !deployment || deployment.metadata?.uid !== controllerRef.uid) {
			return undefined;
		}
		return deployment;
	}

	// Models kubernetes/pkg/controller/deployment/sync.go cleanupDeployment.
	private async cleanupDeployment(
		ctx: context.Context,
		oldReplicaSets: k8s.V1ReplicaSet[],
		deployment: k8s.V1Deployment,
	): Promise<Error | undefined> {
		if (!hasRevisionHistoryLimit(deployment)) {
			return undefined;
		}

		const aliveFilter = (replicaSet: k8s.V1ReplicaSet): boolean =>
			replicaSet.metadata?.deletionTimestamp === undefined;
		const cleanableReplicaSets = filterReplicaSets(oldReplicaSets, aliveFilter);

		const diff = cleanableReplicaSets.length - (deployment.spec?.revisionHistoryLimit ?? 0);
		if (diff <= 0) {
			return undefined;
		}

		const sorted = [...cleanableReplicaSets].sort(compareReplicaSetsByRevision);
		for (let index = 0; index < diff; index++) {
			const replicaSet = sorted[index];
			if (!replicaSet) {
				continue;
			}
			if (
				(replicaSet.status?.replicas ?? 0) !== 0 ||
				(replicaSet.spec?.replicas ?? 1) !== 0 ||
				(replicaSet.metadata?.generation ?? 0) > (replicaSet.status?.observedGeneration ?? 0) ||
				replicaSet.metadata?.deletionTimestamp
			) {
				continue;
			}
			const name = replicaSet.metadata?.name;
			if (!name) {
				continue;
			}
			try {
				await this.api.appsv1.deleteNamespacedReplicaSet({
					name,
					namespace: replicaSet.metadata?.namespace ?? deployment.metadata?.namespace ?? "default",
				});
			} catch (error) {
				if (!isNotFoundError(error)) {
					return error instanceof Error ? error : new Error(String(error));
				}
			}
		}
		return undefined;
	}

	// Models kubernetes/pkg/controller/deployment/recreate.go scaleDownOldReplicaSetsForRecreate.
	async scaleDownOldReplicaSetsForRecreate(
		ctx: context.Context,
		oldRSs: k8s.V1ReplicaSet[],
		deployment: k8s.V1Deployment,
	): Promise<[scaled: boolean, err: Error | undefined]> {
		let scaled = false;
		for (const rs of oldRSs) {
			if ((rs.spec?.replicas ?? 1) === 0) {
				continue;
			}
			const [scaledRS, updatedRS, err] = await this.scaleReplicaSet(ctx, rs, 0, deployment, false);
			if (err) {
				return [false, err];
			}
			if (scaledRS) {
				rs.spec = updatedRS?.spec;
				rs.metadata = updatedRS?.metadata;
				rs.status = updatedRS?.status;
				scaled = true;
			}
		}
		return [scaled, undefined];
	}

	// Models kubernetes/pkg/controller/deployment/recreate.go scaleUpNewReplicaSetForRecreate.
	async scaleUpNewReplicaSetForRecreate(
		ctx: context.Context,
		newReplicaSet: k8s.V1ReplicaSet,
		deployment: k8s.V1Deployment,
	): Promise<[scaled: boolean, err: Error | undefined]> {
		return await this.scaleReplicaSet(
			ctx,
			newReplicaSet,
			deployment.spec?.replicas ?? 1,
			deployment,
			false,
		).then(([scaled, , err]) => [scaled, err]);
	}

	// Models kubernetes/pkg/controller/deployment/rolling.go reconcileNewReplicaSet.
	async reconcileNewReplicaSet(
		ctx: context.Context,
		allReplicaSets: k8s.V1ReplicaSet[],
		newReplicaSet: k8s.V1ReplicaSet,
		deployment: k8s.V1Deployment,
	): Promise<[scaled: boolean, err: Error | undefined]> {
		const desired = deployment.spec?.replicas ?? 1;
		const current = newReplicaSet.spec?.replicas ?? 1;
		if (current === desired) {
			return [false, undefined];
		}
		if (current > desired) {
			const [scaled, , err] = await this.scaleReplicaSet(
				ctx,
				newReplicaSet,
				desired,
				deployment,
				false,
			);
			return [scaled, err];
		}
		const [newReplicasCount, err] = newRSNewReplicas(deployment, allReplicaSets, newReplicaSet);
		if (err) {
			return [false, err];
		}
		const [scaled, , scaleErr] = await this.scaleReplicaSet(
			ctx,
			newReplicaSet,
			newReplicasCount,
			deployment,
			false,
		);
		return [scaled, scaleErr];
	}

	// Models kubernetes/pkg/controller/deployment/rolling.go reconcileOldReplicaSets.
	async reconcileOldReplicaSets(
		ctx: context.Context,
		allReplicaSets: k8s.V1ReplicaSet[],
		oldReplicaSets: k8s.V1ReplicaSet[],
		newReplicaSet: k8s.V1ReplicaSet,
		deployment: k8s.V1Deployment,
	): Promise<[scaled: boolean, err: Error | undefined]> {
		const oldPodsCount = getReplicaCountForReplicaSets(oldReplicaSets);
		if (oldPodsCount === 0) {
			return [false, undefined];
		}
		const allPodsCount = getReplicaCountForReplicaSets(allReplicaSets);
		const maxUnavailablePods = maxUnavailable(deployment);
		const minAvailable = (deployment.spec?.replicas ?? 1) - maxUnavailablePods;
		const newReplicaSetUnavailablePodCount =
			(newReplicaSet.spec?.replicas ?? 1) - (newReplicaSet.status?.availableReplicas ?? 0);
		const maxScaledDown = allPodsCount - minAvailable - newReplicaSetUnavailablePodCount;
		if (maxScaledDown <= 0) {
			return [false, undefined];
		}
		const [remainingOldReplicaSets, cleanupCount, cleanupErr] = await this.cleanupUnhealthyReplicas(
			ctx,
			oldReplicaSets,
			deployment,
			maxScaledDown,
		);
		if (cleanupErr) {
			return [false, undefined];
		}
		const [scaledDownCount, scaleDownErr] = await this.scaleDownOldReplicaSetsForRollingUpdate(
			ctx,
			[...remainingOldReplicaSets, newReplicaSet],
			remainingOldReplicaSets,
			deployment,
		);
		if (scaleDownErr) {
			return [false, undefined];
		}
		return [cleanupCount + scaledDownCount > 0, undefined];
	}

	// Models kubernetes/pkg/controller/deployment/rolling.go cleanupUnhealthyReplicas.
	async cleanupUnhealthyReplicas(
		ctx: context.Context,
		oldReplicaSets: k8s.V1ReplicaSet[],
		deployment: k8s.V1Deployment,
		maxCleanupCount: number,
	): Promise<[oldReplicaSets: k8s.V1ReplicaSet[], cleanupCount: number, err: Error | undefined]> {
		const sorted = [...oldReplicaSets].sort(compareReplicaSetsByCreationTimestamp);
		let totalScaledDown = 0;
		for (let i = 0; i < sorted.length; i++) {
			const replicaSet = sorted[i];
			if (totalScaledDown >= maxCleanupCount) {
				break;
			}
			const replicas = replicaSet.spec?.replicas ?? 1;
			if (replicas === 0 || replicas === (replicaSet.status?.availableReplicas ?? 0)) {
				continue;
			}
			const scaledDownCount = Math.min(
				maxCleanupCount - totalScaledDown,
				replicas - (replicaSet.status?.availableReplicas ?? 0),
			);
			const newReplicasCount = replicas - scaledDownCount;
			if (newReplicasCount > replicas) {
				return [
					[],
					0,
					new Error(
						`when cleaning up unhealthy replicas, got invalid request to scale down ${replicaSet.metadata?.namespace ?? "default"}/${replicaSet.metadata?.name ?? ""} ${replicas} -> ${newReplicasCount}`,
					),
				];
			}
			const [, updatedOldRS, err] = await this.scaleReplicaSet(
				ctx,
				replicaSet,
				newReplicasCount,
				deployment,
				false,
			);
			if (err) {
				return [sorted, totalScaledDown, err];
			}
			totalScaledDown += scaledDownCount;
			if (updatedOldRS) {
				sorted[i] = updatedOldRS;
			}
		}
		return [sorted, totalScaledDown, undefined];
	}

	// Models kubernetes/pkg/controller/deployment/rolling.go scaleDownOldReplicaSetsForRollingUpdate.
	async scaleDownOldReplicaSetsForRollingUpdate(
		ctx: context.Context,
		allReplicaSets: k8s.V1ReplicaSet[],
		oldReplicaSets: k8s.V1ReplicaSet[],
		deployment: k8s.V1Deployment,
	): Promise<[scaledDownCount: number, err: Error | undefined]> {
		const maxUnavailablePods = maxUnavailable(deployment);
		const minAvailable = (deployment.spec?.replicas ?? 1) - maxUnavailablePods;
		const availablePodCount = getAvailableReplicaCountForReplicaSets(allReplicaSets);
		if (availablePodCount <= minAvailable) {
			return [0, undefined];
		}
		oldReplicaSets.sort(compareReplicaSetsByCreationTimestamp);
		let totalScaledDown = 0;
		const totalScaleDownCount = availablePodCount - minAvailable;
		for (const replicaSet of oldReplicaSets) {
			if (totalScaledDown >= totalScaleDownCount) {
				break;
			}
			const replicas = replicaSet.spec?.replicas ?? 1;
			if (replicas === 0) {
				continue;
			}
			const scaleDownCount = Math.min(replicas, totalScaleDownCount - totalScaledDown);
			const newReplicasCount = replicas - scaleDownCount;
			if (newReplicasCount > replicas) {
				return [
					0,
					new Error(
						`when scaling down old RS, got invalid request to scale down ${replicaSet.metadata?.namespace ?? "default"}/${replicaSet.metadata?.name ?? ""} ${replicas} -> ${newReplicasCount}`,
					),
				];
			}
			const [, , err] = await this.scaleReplicaSet(
				ctx,
				replicaSet,
				newReplicasCount,
				deployment,
				false,
			);
			if (err) {
				return [totalScaledDown, err];
			}
			totalScaledDown += scaleDownCount;
		}
		return [totalScaledDown, undefined];
	}
}

function deploymentKey(deployment: k8s.V1Deployment): string | undefined {
	const [key, err] = keyFunc(deployment);
	if (err) {
		return undefined;
	}
	return key;
}

function deploymentKeyFunc(
	deployment: k8s.V1Deployment | ExplicitKey,
): [string, Error | undefined] {
	if (deployment instanceof ExplicitKey) {
		return [deployment.key, undefined];
	}
	return keyFunc(deployment);
}

function replicaSetKey(replicaSet: k8s.V1ReplicaSet): string {
	return `${replicaSet.metadata?.namespace ?? "default"}/${replicaSet.metadata?.name ?? ""}`;
}

function replicaSetKeyFunc(
	replicaSet: k8s.V1ReplicaSet | ExplicitKey,
): [string, Error | undefined] {
	if (replicaSet instanceof ExplicitKey) {
		return [replicaSet.key, undefined];
	}
	return [replicaSetKey(replicaSet), undefined];
}

function podKey(pod: k8s.V1Pod): string {
	return `${pod.metadata?.namespace ?? "default"}/${pod.metadata?.name ?? ""}`;
}

function podKeyFunc(pod: k8s.V1Pod | ExplicitKey): [string, Error | undefined] {
	if (pod instanceof ExplicitKey) {
		return [pod.key, undefined];
	}
	return [podKey(pod), undefined];
}

// Models kubernetes/pkg/controller/deployment/sync.go generateReplicaSetName.
function generateReplicaSetName(deploymentName: string, podTemplateSpecHash: string): string {
	const maxDeploymentNameLength =
		dns1123SubdomainMaxLength - replicaSetNameSeparator.length - podTemplateSpecHash.length;
	if (deploymentName.length > maxDeploymentNameLength && maxDeploymentNameLength > 0) {
		return `${deploymentName.slice(0, maxDeploymentNameLength)}${replicaSetNameSeparator}${podTemplateSpecHash}`;
	}
	return `${deploymentName}${replicaSetNameSeparator}${podTemplateSpecHash}`;
}

function isAlreadyExistsError(error: Error): boolean {
	return (
		error.name === "AlreadyExists" ||
		error.message.includes("already exists") ||
		error.message.includes("HTTP-Code: 409")
	);
}

function compareReplicaSetsBySizeNewer(left: k8s.V1ReplicaSet, right: k8s.V1ReplicaSet): number {
	const sizeDiff = (right.spec?.replicas ?? 1) - (left.spec?.replicas ?? 1);
	if (sizeDiff !== 0) {
		return sizeDiff;
	}
	return -compareReplicaSetsByCreationTimestamp(left, right);
}

function compareReplicaSetsBySizeOlder(left: k8s.V1ReplicaSet, right: k8s.V1ReplicaSet): number {
	const sizeDiff = (right.spec?.replicas ?? 1) - (left.spec?.replicas ?? 1);
	if (sizeDiff !== 0) {
		return sizeDiff;
	}
	return compareReplicaSetsByCreationTimestamp(left, right);
}

// Models staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/controller_ref.go NewControllerRef.
function ownerReference(deployment: k8s.V1Deployment): k8s.V1OwnerReference {
	return {
		apiVersion: "apps/v1",
		kind: "Deployment",
		name: deployment.metadata?.name ?? "",
		uid: deployment.metadata?.uid ?? "",
		controller: true,
		blockOwnerDeletion: true,
	};
}
