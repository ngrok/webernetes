/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import * as k8s from "../client";
import { getControllerOf } from "../apimachinery/pkg/apis/meta/v1/controller_ref";
import { getDeletionCostFromPodAnnotations } from "../apis/core/helper/helpers";
import { validatePodName } from "../apis/core/validation/validation";
import { safeEncodeString } from "../apimachinery/pkg/util/rand/rand";
import { hasStatusCause, isNotFoundError } from "../client/errors";
import type { EventRecorder } from "../client-go/tools/record/event";
import type { Indexer } from "../client-go/tools/cache/index";
import {
	ExplicitKey,
	metaNamespaceKeyFunc,
	newStore,
	type Store,
} from "../client-go/tools/cache/store";
import { getClock } from "../clock-context";
import * as podutil from "../cluster/api/v1/pod/util";
import * as fnv from "../fnv";
import type * as context from "../go/context";
import { Mutex } from "../go/sync/mutex";
import type { PassiveClock } from "../utils/clock/clock";
import * as hashutil from "../util/hash/hash";

const podPhaseToOrdinal: Record<string, number> = { Pending: 0, Unknown: 1, Running: 2 };
const podControllerIndex = "podController";
const namespaceTerminatingCause = "NamespaceTerminating";

// Models kubernetes/pkg/controller/controller_utils.go ExpectationsTimeout.
export const expectationsTimeoutMs = 5 * 60 * 1000;

// Models kubernetes/pkg/controller/controller_utils.go FailedCreatePodReason.
export const failedCreatePodReason = "FailedCreate";

// Models kubernetes/pkg/controller/controller_utils.go SuccessfulCreatePodReason.
export const successfulCreatePodReason = "SuccessfulCreate";

// Models kubernetes/pkg/controller/controller_utils.go FailedDeletePodReason.
export const failedDeletePodReason = "FailedDelete";

// Models kubernetes/pkg/controller/controller_utils.go SuccessfulDeletePodReason.
export const successfulDeletePodReason = "SuccessfulDelete";

// Models kubernetes/pkg/controller/controller_utils.go FilterActiveReplicaSets.
export function filterActiveReplicaSets(replicaSets: k8s.V1ReplicaSet[]): k8s.V1ReplicaSet[] {
	return filterReplicaSets(replicaSets, (replicaSet) => (replicaSet.spec?.replicas ?? 0) > 0);
}

// Models kubernetes/pkg/controller/controller_utils.go KeyFunc.
export function keyFunc(obj: k8s.KubernetesObject): [string, Error | undefined] {
	return metaNamespaceKeyFunc(obj);
}

// Models kubernetes/pkg/controller/controller_utils.go PodControllerIndexKey.
export function podControllerIndexKey(
	namespace: string,
	ownerReference: k8s.V1OwnerReference | undefined,
): string {
	if (!ownerReference) {
		return namespace;
	}
	return `${namespace}/${ownerReference.kind}/${ownerReference.name}/${ownerReference.uid}`;
}

// Models kubernetes/pkg/controller/controller_utils.go AddPodControllerIndexer.
// This differs from upstream because we don't currently have the notion of a
// cache.SharedIndexInformer.
export function addPodControllerIndexer(podIndexer: Indexer<k8s.V1Pod>): Error | undefined {
	if (podIndexer.getIndexers()[podControllerIndex]) {
		return undefined;
	}
	return podIndexer.addIndexers({
		[podControllerIndex]: (pod) => [
			[podControllerIndexKey(pod.metadata?.namespace ?? "", getControllerOf(pod))],
			undefined,
		],
	});
}

// Models kubernetes/pkg/controller/controller_utils.go FilterPodsByOwner.
export function filterPodsByOwner(
	podIndexer: Indexer<k8s.V1Pod>,
	owner: k8s.V1ObjectMeta,
	ownerKind: string,
	includeOrphanedPods: boolean,
): [k8s.V1Pod[], Error | undefined] {
	const result: k8s.V1Pod[] = [];
	if (!owner.namespace) {
		return [[], new Error("no owner namespace provided")];
	}
	if (!owner.name) {
		return [[], new Error("no owner name provided")];
	}
	if (!owner.uid) {
		return [[], new Error("no owner uid provided")];
	}
	if (!ownerKind) {
		return [[], new Error("no owner kind provided")];
	}
	const keys = [
		podControllerIndexKey(owner.namespace, {
			apiVersion: "",
			name: owner.name,
			kind: ownerKind,
			uid: owner.uid,
		}),
	];
	if (includeOrphanedPods) {
		keys.push(podControllerIndexKey(owner.namespace, undefined));
	}
	for (const key of keys) {
		const [pods, err] = podIndexer.byIndex(podControllerIndex, key);
		if (err) {
			return [[], err];
		}
		result.push(...pods);
	}
	return [result, undefined];
}

// Models kubernetes/pkg/controller/controller_utils.go ControlleeExpectations.
export class ControlleeExpectations {
	add_: number;
	del: number;

	constructor(
		add_: number,
		del: number,
		readonly key: string,
		readonly timestamp: Date,
		private readonly ctx?: context.Context,
	) {
		this.add_ = add_;
		this.del = del;
	}

	// Models kubernetes/pkg/controller/controller_utils.go Add.
	add(add: number, del: number): void {
		this.add_ += add;
		this.del += del;
	}

	// Models kubernetes/pkg/controller/controller_utils.go Fulfilled.
	fulfilled(): boolean {
		return this.add_ <= 0 && this.del <= 0;
	}

	// Models kubernetes/pkg/controller/controller_utils.go GetExpectations.
	getExpectations(): [add: number, del: number] {
		return [this.add_, this.del];
	}

	// Models kubernetes/pkg/controller/controller_utils.go isExpired.
	isExpired(): boolean {
		if (!this.ctx) {
			throw new Error("controllee expectations missing context");
		}
		return getClock(this.ctx).since(this.timestamp) > expectationsTimeoutMs;
	}

	storeCopy(): ControlleeExpectations {
		return new ControlleeExpectations(this.add_, this.del, this.key, this.timestamp);
	}
}

// Models kubernetes/pkg/controller/controller_utils.go ExpKeyFunc.
export function expKeyFunc(obj: ControlleeExpectations | ExplicitKey): [string, Error | undefined] {
	if (obj instanceof ExplicitKey) {
		return [obj.key, undefined];
	}
	if (obj.key) {
		return [obj.key, undefined];
	}
	return ["", new Error(`could not find key for obj ${JSON.stringify(obj)}`)];
}

// Models kubernetes/pkg/controller/controller_utils.go UIDSet.
class UIDSet {
	constructor(
		readonly string: Set<string>,
		readonly key: string,
	) {}
}

// Models kubernetes/pkg/controller/controller_utils.go UIDSetKeyFunc.
function uidSetKeyFunc(obj: UIDSet | ExplicitKey): [string, Error | undefined] {
	if (obj instanceof ExplicitKey) {
		return [obj.key, undefined];
	}
	if (obj.key) {
		return [obj.key, undefined];
	}
	return ["", new Error(`could not find key for obj ${JSON.stringify(obj)}`)];
}

// Models kubernetes/pkg/controller/controller_utils.go ControllerExpectations.
export class ControllerExpectations {
	store: Store<ControlleeExpectations>;
	private readonly lock = new Mutex();

	constructor(private readonly ctx: context.Context) {
		this.store = newStore<ControlleeExpectations>(expKeyFunc);
	}

	// Models kubernetes/pkg/controller/controller_utils.go GetExpectations.
	getExpectations(
		controllerKey: string,
	): [exp: ControlleeExpectations | undefined, exists: boolean, err: Error | undefined] {
		const [exp, exists, err] = this.store.getByKey(controllerKey);
		return [exp ? this.withContext(exp) : undefined, exists, err];
	}

	// Models kubernetes/pkg/controller/controller_utils.go SatisfiedExpectations.
	satisfiedExpectations(controllerKey: string): boolean {
		const [exp, exists, err] = this.getExpectations(controllerKey);
		if (exists) {
			return exp?.fulfilled() || exp?.isExpired() || false;
		}
		return err !== undefined || !exists;
	}

	// Models kubernetes/pkg/controller/controller_utils.go DeleteExpectations.
	async deleteExpectations(controllerKey: string): Promise<void> {
		await this.lock.withLock(async () => {
			const [exp, exists, err] = this.store.getByKey(controllerKey);
			if (!err && exists && exp) {
				await this.store.delete(exp);
			}
		});
	}

	// Models kubernetes/pkg/controller/controller_utils.go setExpectations.
	async setExpectations(
		controllerKey: string,
		add: number,
		del: number,
	): Promise<Error | undefined> {
		return await this.lock.withLock(
			async () =>
				await this.store.add(
					new ControlleeExpectations(add, del, controllerKey, getClock(this.ctx).now()),
				),
		);
	}

	// Models kubernetes/pkg/controller/controller_utils.go ExpectCreations.
	async expectCreations(controllerKey: string, adds: number): Promise<Error | undefined> {
		return await this.setExpectations(controllerKey, adds, 0);
	}

	// Models kubernetes/pkg/controller/controller_utils.go ExpectDeletions.
	async expectDeletions(controllerKey: string, dels: number): Promise<Error | undefined> {
		return await this.setExpectations(controllerKey, 0, dels);
	}

	// Models kubernetes/pkg/controller/controller_utils.go CreationObserved.
	async creationObserved(controllerKey: string): Promise<void> {
		await this.lowerExpectations(controllerKey, 1, 0);
	}

	// Models kubernetes/pkg/controller/controller_utils.go DeletionObserved.
	async deletionObserved(controllerKey: string): Promise<void> {
		await this.lowerExpectations(controllerKey, 0, 1);
	}

	// Models kubernetes/pkg/controller/controller_utils.go RaiseExpectations.
	async raiseExpectations(controllerKey: string, add: number, del: number): Promise<void> {
		await this.lock.withLock(async () => {
			const [exp, exists, err] = this.getExpectations(controllerKey);
			if (!err && exists && exp) {
				exp.add(add, del);
				await this.store.update(exp.storeCopy());
			}
		});
	}

	// Models kubernetes/pkg/controller/controller_utils.go LowerExpectations.
	async lowerExpectations(controllerKey: string, add: number, del: number): Promise<void> {
		await this.lock.withLock(async () => {
			const [exp, exists, err] = this.getExpectations(controllerKey);
			if (!err && exists && exp) {
				exp.add(-add, -del);
				await this.store.update(exp.storeCopy());
			}
		});
	}

	private withContext(exp: ControlleeExpectations): ControlleeExpectations {
		return new ControlleeExpectations(exp.add_, exp.del, exp.key, exp.timestamp, this.ctx);
	}
}

// Models kubernetes/pkg/controller/controller_utils.go NewControllerExpectations.
export function newControllerExpectations(ctx: context.Context): ControllerExpectations {
	return new ControllerExpectations(ctx);
}

// Models kubernetes/pkg/controller/controller_utils.go UIDTrackingControllerExpectations.
export class UIDTrackingControllerExpectations {
	private readonly uidStoreLock = new Mutex();
	private readonly uidStore: Store<UIDSet> = newStore<UIDSet>(uidSetKeyFunc);

	constructor(private readonly controllerExpectations: ControllerExpectations) {}

	// Models kubernetes/pkg/controller/controller_utils.go GetExpectations.
	getExpectations(
		controllerKey: string,
	): [exp: ControlleeExpectations | undefined, exists: boolean, err: Error | undefined] {
		return this.controllerExpectations.getExpectations(controllerKey);
	}

	// Models kubernetes/pkg/controller/controller_utils.go SatisfiedExpectations.
	satisfiedExpectations(controllerKey: string): boolean {
		return this.controllerExpectations.satisfiedExpectations(controllerKey);
	}

	// Models kubernetes/pkg/controller/controller_utils.go GetUIDs.
	getUIDs(controllerKey: string): Set<string> | undefined {
		const [uid, exists, err] = this.uidStore.getByKey(controllerKey);
		if (!err && exists) {
			return uid?.string;
		}
		return undefined;
	}

	// Models kubernetes/pkg/controller/controller_utils.go ExpectCreations.
	async expectCreations(controllerKey: string, adds: number): Promise<Error | undefined> {
		return await this.controllerExpectations.expectCreations(controllerKey, adds);
	}

	// Models kubernetes/pkg/controller/controller_utils.go ExpectDeletions.
	async expectDeletions(rcKey: string, deletedKeys: string[]): Promise<Error | undefined> {
		const expectedUIDs = new Set(deletedKeys);
		return await this.uidStoreLock.withLock(async () => {
			const addErr = await this.uidStore.add(new UIDSet(expectedUIDs, rcKey));
			if (addErr) {
				return addErr;
			}
			return await this.controllerExpectations.expectDeletions(rcKey, expectedUIDs.size);
		});
	}

	// Models kubernetes/pkg/controller/controller_utils.go CreationObserved.
	async creationObserved(controllerKey: string): Promise<void> {
		await this.controllerExpectations.creationObserved(controllerKey);
	}

	// Models kubernetes/pkg/controller/controller_utils.go DeletionObserved.
	async deletionObserved(controllerKey: string, deleteKey: string): Promise<void> {
		await this.uidStoreLock.withLock(async () => {
			const uids = this.getUIDs(controllerKey);
			if (uids?.has(deleteKey)) {
				await this.controllerExpectations.deletionObserved(controllerKey);
				uids.delete(deleteKey);
				await this.uidStore.update(new UIDSet(uids, controllerKey));
			}
		});
	}

	// Models kubernetes/pkg/controller/controller_utils.go DeleteExpectations.
	async deleteExpectations(controllerKey: string): Promise<void> {
		await this.uidStoreLock.withLock(async () => {
			await this.controllerExpectations.deleteExpectations(controllerKey);
			const [uidExp, exists, err] = this.uidStore.getByKey(controllerKey);
			if (!err && exists && uidExp) {
				await this.uidStore.delete(uidExp);
			}
		});
	}
}

// Models kubernetes/pkg/controller/controller_utils.go NewUIDTrackingControllerExpectations.
export function newUIDTrackingControllerExpectations(
	controllerExpectations: ControllerExpectations,
): UIDTrackingControllerExpectations {
	return new UIDTrackingControllerExpectations(controllerExpectations);
}

// Models kubernetes/pkg/controller/controller_utils.go PodControlInterface.
export interface PodControlInterface {
	createPods(
		ctx: context.Context,
		namespace: string,
		template: k8s.V1PodTemplateSpec,
		object: k8s.KubernetesObject,
		controllerRef: k8s.V1OwnerReference,
	): Promise<Error | undefined>;
	createPodsWithGenerateName(
		ctx: context.Context,
		namespace: string,
		template: k8s.V1PodTemplateSpec,
		object: k8s.KubernetesObject,
		controllerRef: k8s.V1OwnerReference,
		generateName: string,
	): Promise<Error | undefined>;
	deletePod(
		ctx: context.Context,
		namespace: string,
		podID: string,
		object: k8s.KubernetesObject,
	): Promise<Error | undefined>;
	patchPod(
		ctx: context.Context,
		namespace: string,
		name: string,
		data: Uint8Array,
	): Promise<Error | undefined>;
}

// Models kubernetes/pkg/controller/controller_utils.go RealPodControl.
export class RealPodControl implements PodControlInterface {
	constructor(
		private readonly kubeClient: k8s.KubeClient["corev1"],
		private readonly recorder: EventRecorder,
		readonly onWrite?: (
			pod: k8s.V1Pod,
			controllerRef: k8s.V1OwnerReference | undefined,
		) => void | Promise<void>,
	) {}

	// Models kubernetes/pkg/controller/controller_utils.go CreatePods.
	async createPods(
		ctx: context.Context,
		namespace: string,
		template: k8s.V1PodTemplateSpec,
		object: k8s.KubernetesObject,
		controllerRef: k8s.V1OwnerReference,
	): Promise<Error | undefined> {
		return await this.createPodsWithGenerateName(
			ctx,
			namespace,
			template,
			object,
			controllerRef,
			"",
		);
	}

	// Models kubernetes/pkg/controller/controller_utils.go CreatePodsWithGenerateName.
	async createPodsWithGenerateName(
		ctx: context.Context,
		namespace: string,
		template: k8s.V1PodTemplateSpec,
		controllerObject: k8s.KubernetesObject,
		controllerRef: k8s.V1OwnerReference,
		generateName: string,
	): Promise<Error | undefined> {
		const validationErr = validateControllerRef(controllerRef);
		if (validationErr) {
			return validationErr;
		}
		const [pod, err] = getPodFromTemplate(template, controllerObject, controllerRef);
		if (err || !pod) {
			return err;
		}
		if (generateName.length > 0) {
			pod.metadata ??= {};
			pod.metadata.generateName = generateName;
		}
		return await this.createPodsInner(ctx, namespace, pod, controllerObject, controllerRef);
	}

	// Models kubernetes/pkg/controller/controller_utils.go PatchPod.
	async patchPod(
		_ctx: context.Context,
		namespace: string,
		name: string,
		data: Uint8Array,
	): Promise<Error | undefined> {
		try {
			const body = JSON.parse(new TextDecoder().decode(data)) as unknown;
			if (typeof body !== "object" || body === null || Array.isArray(body)) {
				return new Error("decoded pod patch must be an object");
			}
			const pod = await this.kubeClient.patchNamespacedPod(
				{
					namespace,
					name,
					body,
				},
				k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.StrategicMergePatch),
			);
			if (this.onWrite) {
				await this.onWrite(pod, getControllerOf(pod));
			}
			return undefined;
		} catch (error) {
			return toError(error);
		}
	}

	// Models kubernetes/pkg/controller/controller_utils.go createPods.
	private async createPodsInner(
		_ctx: context.Context,
		namespace: string,
		pod: k8s.V1Pod,
		object: k8s.KubernetesObject,
		controllerRef: k8s.V1OwnerReference,
	): Promise<Error | undefined> {
		if (Object.keys(pod.metadata?.labels ?? {}).length === 0) {
			return new Error("unable to create pods, no labels");
		}
		let newPod: k8s.V1Pod;
		try {
			newPod = await this.kubeClient.createNamespacedPod({ namespace, body: pod });
		} catch (error) {
			if (!hasStatusCause(error, namespaceTerminatingCause)) {
				await this.recorder.eventf(
					object,
					"Warning",
					failedCreatePodReason,
					"Error creating: %v",
					error,
				);
			}
			return toError(error);
		}
		if (this.onWrite) {
			await this.onWrite(newPod, controllerRef);
		}
		await this.recorder.eventf(
			object,
			"Normal",
			successfulCreatePodReason,
			"Created pod: %v",
			newPod.metadata?.name ?? "",
		);
		return undefined;
	}

	// Models kubernetes/pkg/controller/controller_utils.go DeletePod.
	async deletePod(
		_ctx: context.Context,
		namespace: string,
		podID: string,
		object: k8s.KubernetesObject,
	): Promise<Error | undefined> {
		try {
			await this.kubeClient.deleteNamespacedPod({ namespace, name: podID });
		} catch (error) {
			if (isNotFoundError(error)) {
				return toError(error);
			}
			await this.recorder.eventf(
				object,
				"Warning",
				failedDeletePodReason,
				"Error deleting: %v",
				error,
			);
			return new Error(`unable to delete pods: ${String(error)}`);
		}
		await this.recorder.eventf(
			object,
			"Normal",
			successfulDeletePodReason,
			"Deleted pod: %v",
			podID,
		);
		return undefined;
	}
}

// Models kubernetes/pkg/controller/controller_utils.go GetPodFromTemplate.
export function getPodFromTemplate(
	template: k8s.V1PodTemplateSpec,
	parentObject: k8s.KubernetesObject,
	controllerRef: k8s.V1OwnerReference | undefined,
): [k8s.V1Pod | undefined, Error | undefined] {
	const desiredLabels = getPodsLabelSet(template);
	const desiredFinalizers = getPodsFinalizers(template);
	const desiredAnnotations = getPodsAnnotationSet(template);
	const name = parentObject.metadata?.name;
	if (!name) {
		return [undefined, new Error("parentObject does not have ObjectMeta")];
	}
	const prefix = getPodsPrefix(name);

	const pod: k8s.V1Pod = {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			labels: desiredLabels,
			annotations: desiredAnnotations,
			generateName: prefix,
			finalizers: desiredFinalizers,
		},
		spec: structuredClone(template.spec ?? { containers: [] }),
	};
	if (controllerRef) {
		pod.metadata ??= {};
		pod.metadata.ownerReferences = [controllerRef];
	}
	return [pod, undefined];
}

// Models kubernetes/pkg/controller/controller_utils.go getPodsLabelSet.
function getPodsLabelSet(template: k8s.V1PodTemplateSpec): Record<string, string> {
	return { ...(template.metadata?.labels ?? {}) };
}

// Models kubernetes/pkg/controller/controller_utils.go getPodsFinalizers.
function getPodsFinalizers(template: k8s.V1PodTemplateSpec): string[] {
	return [...(template.metadata?.finalizers ?? [])];
}

// Models kubernetes/pkg/controller/controller_utils.go getPodsAnnotationSet.
function getPodsAnnotationSet(template: k8s.V1PodTemplateSpec): Record<string, string> {
	return { ...(template.metadata?.annotations ?? {}) };
}

// Models kubernetes/pkg/controller/controller_utils.go getPodsPrefix.
function getPodsPrefix(controllerName: string): string {
	const prefix = `${controllerName}-`;
	return validatePodName(prefix, true).length === 0 ? prefix : controllerName;
}

// Models kubernetes/pkg/controller/controller_utils.go validateControllerRef.
function validateControllerRef(controllerRef: k8s.V1OwnerReference | undefined): Error | undefined {
	if (!controllerRef) {
		return new Error("controllerRef is nil");
	}
	if (!controllerRef.apiVersion) {
		return new Error("controllerRef has empty APIVersion");
	}
	if (!controllerRef.kind) {
		return new Error("controllerRef has empty Kind");
	}
	if (!controllerRef.controller) {
		return new Error("controllerRef.Controller is not set to true");
	}
	if (!controllerRef.blockOwnerDeletion) {
		return new Error("controllerRef.BlockOwnerDeletion is not set");
	}
	return undefined;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

// Models kubernetes/pkg/controller/controller_utils.go filterRS.
type FilterReplicaSet = (replicaSet: k8s.V1ReplicaSet) => boolean;

// Models kubernetes/pkg/controller/controller_utils.go FilterReplicaSets.
export function filterReplicaSets(
	replicaSets: k8s.V1ReplicaSet[],
	filterFn: FilterReplicaSet,
): k8s.V1ReplicaSet[] {
	return replicaSets.filter(filterFn);
}

// Models kubernetes/pkg/controller/controller_utils.go ReplicaSetsByCreationTimestamp.
export function compareReplicaSetsByCreationTimestamp(
	left: k8s.V1ReplicaSet,
	right: k8s.V1ReplicaSet,
): number {
	const leftTime = creationTimestampMs(left);
	const rightTime = creationTimestampMs(right);
	if (leftTime !== rightTime) {
		return leftTime - rightTime;
	}
	return (left.metadata?.name ?? "").localeCompare(right.metadata?.name ?? "");
}

// Models kubernetes/pkg/controller/controller_utils.go ActivePodsWithRanks.
export class ActivePodsWithRanks {
	constructor(
		readonly pods: k8s.V1Pod[],
		readonly rank: number[],
		readonly now?: Date,
	) {}

	len(): number {
		return this.pods.length;
	}

	swap(i: number, j: number): void {
		[this.pods[i], this.pods[j]] = [this.pods[j], this.pods[i]];
		[this.rank[i], this.rank[j]] = [this.rank[j], this.rank[i]];
	}

	sort(): void {
		for (let i = 1; i < this.len(); i++) {
			for (let j = i; j > 0 && this.less(j, j - 1); j--) {
				this.swap(j, j - 1);
			}
		}
	}

	less(i: number, j: number): boolean {
		const left = this.pods[i];
		const right = this.pods[j];
		const leftNodeName = left.spec?.nodeName ?? "";
		const rightNodeName = right.spec?.nodeName ?? "";
		if (
			leftNodeName !== rightNodeName &&
			(leftNodeName.length === 0 || rightNodeName.length === 0)
		) {
			return leftNodeName.length === 0;
		}
		if (podPhaseOrdinal(left) !== podPhaseOrdinal(right)) {
			return podPhaseOrdinal(left) < podPhaseOrdinal(right);
		}
		if (podutil.isPodReady(left) !== podutil.isPodReady(right)) {
			return !podutil.isPodReady(left);
		}

		const [leftDeletionCost] = getDeletionCostFromPodAnnotations(left.metadata?.annotations);
		const [rightDeletionCost] = getDeletionCostFromPodAnnotations(right.metadata?.annotations);
		if (leftDeletionCost !== rightDeletionCost) {
			return leftDeletionCost < rightDeletionCost;
		}

		if (this.rank[i] !== this.rank[j]) {
			return this.rank[i] > this.rank[j];
		}
		if (podutil.isPodReady(left) && podutil.isPodReady(right)) {
			const readyTime1 = podReadyTime(left);
			const readyTime2 = podReadyTime(right);
			if (!timesEqual(readyTime1, readyTime2)) {
				if (!this.now || isZeroTime(readyTime1) || isZeroTime(readyTime2)) {
					return afterOrZero(readyTime1, readyTime2);
				}
				const rankDiff = logarithmicRankDiff(readyTime1, readyTime2, this.now.getTime());
				if (rankDiff === 0) {
					return (left.metadata?.uid ?? "") < (right.metadata?.uid ?? "");
				}
				return rankDiff < 0;
			}
		}
		const restartCompare = compareMaxContainerRestarts(left, right);
		if (restartCompare !== undefined) {
			return restartCompare;
		}
		const leftCreationTimestamp = timestampMs(left.metadata?.creationTimestamp);
		const rightCreationTimestamp = timestampMs(right.metadata?.creationTimestamp);
		if (leftCreationTimestamp !== rightCreationTimestamp) {
			if (
				!this.now ||
				leftCreationTimestamp === undefined ||
				rightCreationTimestamp === undefined
			) {
				return afterOrZero(leftCreationTimestamp, rightCreationTimestamp);
			}
			const rankDiff = logarithmicRankDiff(
				leftCreationTimestamp,
				rightCreationTimestamp,
				this.now.getTime(),
			);
			if (rankDiff === 0) {
				return (left.metadata?.uid ?? "") < (right.metadata?.uid ?? "");
			}
			return rankDiff < 0;
		}
		return false;
	}
}

// Models kubernetes/pkg/controller/controller_utils.go IsPodActive.
export function isPodActive(pod: k8s.V1Pod): boolean {
	return (
		pod.status?.phase !== "Succeeded" &&
		pod.status?.phase !== "Failed" &&
		!pod.metadata?.deletionTimestamp
	);
}

// Models kubernetes/pkg/controller/controller_utils.go IsPodTerminating.
export function isPodTerminating(pod: k8s.V1Pod): boolean {
	return !podutil.isPodTerminal(pod) && !!pod.metadata?.deletionTimestamp;
}

// Models kubernetes/pkg/controller/controller_utils.go ComputeHash.
export function computeHash(template: k8s.V1PodTemplateSpec, collisionCount?: number): string {
	const podTemplateSpecHasher = fnv.new32a();
	hashutil.deepHashObject(
		podTemplateSpecHasher,
		hashutil.jsonMarshal(template as hashutil.JsonValue),
	);
	if (collisionCount !== undefined) {
		const collisionCountBytes = new Uint8Array(8);
		new DataView(collisionCountBytes.buffer).setUint32(0, collisionCount >>> 0, true);
		podTemplateSpecHasher.write(collisionCountBytes);
	}
	return safeEncodeString(String(podTemplateSpecHasher.sum32()));
}

// Models kubernetes/pkg/controller/controller_utils.go nextPodAvailabilityCheck.
export function nextPodAvailabilityCheck(
	pod: k8s.V1Pod,
	minReadySeconds: number,
	now: Date,
): number | undefined {
	if (!podutil.isPodReady(pod) || minReadySeconds <= 0) {
		return undefined;
	}
	const c = podutil.getPodReadyCondition(pod.status ?? {});
	if (!c?.lastTransitionTime) {
		return undefined;
	}
	const lastTransitionTime = timestampMs(c.lastTransitionTime);
	if (lastTransitionTime === undefined) {
		return undefined;
	}
	const nextCheck = lastTransitionTime + minReadySeconds * 1000 - now.getTime();
	if (nextCheck > 0) {
		return nextCheck;
	}
	return undefined;
}

// Models kubernetes/pkg/controller/controller_utils.go findMinNextPodAvailabilitySimpleCheck.
export function findMinNextPodAvailabilitySimpleCheck(
	pods: k8s.V1Pod[],
	minReadySeconds: number,
	now: Date,
): [number | undefined, k8s.V1Pod | undefined] {
	let minAvailabilityCheck: number | undefined;
	let checkPod: k8s.V1Pod | undefined;
	for (const p of pods) {
		const nextCheck = nextPodAvailabilityCheck(p, minReadySeconds, now);
		if (
			nextCheck !== undefined &&
			(minAvailabilityCheck === undefined || nextCheck < minAvailabilityCheck)
		) {
			minAvailabilityCheck = nextCheck;
			checkPod = p;
		}
	}
	return [minAvailabilityCheck, checkPod];
}

// Models kubernetes/pkg/controller/controller_utils.go FindMinNextPodAvailabilityCheck.
export function findMinNextPodAvailabilityCheck(
	pods: k8s.V1Pod[],
	minReadySeconds: number,
	lastOwnerStatusEvaluation: Date,
	clock: PassiveClock,
): number | undefined {
	const [nextCheckAccordingToOwnerStatusEvaluation, checkPod] =
		findMinNextPodAvailabilitySimpleCheck(pods, minReadySeconds, lastOwnerStatusEvaluation);
	if (nextCheckAccordingToOwnerStatusEvaluation === undefined || !checkPod) {
		return undefined;
	}
	const updatedNextCheck = nextPodAvailabilityCheck(checkPod, minReadySeconds, clock.now());
	if (updatedNextCheck !== undefined) {
		return updatedNextCheck;
	}
	return 0;
}

function creationTimestampMs(resource: k8s.KubernetesObject): number {
	const timestamp = resource.metadata?.creationTimestamp;
	if (timestamp instanceof Date) {
		return timestamp.getTime();
	}
	if (typeof timestamp === "string") {
		return Date.parse(timestamp);
	}
	return 0;
}

// Models kubernetes/pkg/controller/controller_utils.go podReadyTime.
function podReadyTime(pod: k8s.V1Pod): number {
	if (podutil.isPodReady(pod)) {
		const condition = podutil.getPodReadyCondition(pod.status ?? {});
		if (condition?.status === "True") {
			return timestampMs(condition.lastTransitionTime) ?? 0;
		}
	}
	return 0;
}

// Models staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/time.go Equal.
function timesEqual(left: number | undefined, right: number | undefined): boolean {
	return left === right;
}

// Models kubernetes/pkg/controller/controller_utils.go afterOrZero.
function afterOrZero(left: number | undefined, right: number | undefined): boolean {
	if (isZeroTime(left) || isZeroTime(right)) {
		return isZeroTime(left);
	}
	return (left ?? 0) > (right ?? 0);
}

// Models staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/time.go IsZero.
function isZeroTime(value: number | undefined): boolean {
	return value === undefined || value === 0;
}

// Models kubernetes/pkg/controller/controller_utils.go logarithmicRankDiff.
function logarithmicRankDiff(leftTime: number, rightTime: number, now: number): number {
	const d1 = now - leftTime;
	const d2 = now - rightTime;
	const r1 = d1 > 0 ? Math.floor(Math.log2(d1)) : -1;
	const r2 = d2 > 0 ? Math.floor(Math.log2(d2)) : -1;
	return r1 - r2;
}

// Models kubernetes/pkg/controller/controller_utils.go podPhaseToOrdinal.
function podPhaseOrdinal(pod: k8s.V1Pod): number {
	return podPhaseToOrdinal[pod.status?.phase ?? ""] ?? 0;
}

// Models kubernetes/pkg/controller/controller_utils.go compareMaxContainerRestarts.
function compareMaxContainerRestarts(left: k8s.V1Pod, right: k8s.V1Pod): boolean | undefined {
	const [regularRestartsI, sidecarRestartsI] = maxContainerRestarts(left);
	const [regularRestartsJ, sidecarRestartsJ] = maxContainerRestarts(right);
	if (regularRestartsI !== regularRestartsJ) {
		return regularRestartsI > regularRestartsJ;
	}
	if (sidecarRestartsI !== sidecarRestartsJ) {
		return sidecarRestartsI > sidecarRestartsJ;
	}
	return undefined;
}

// Models kubernetes/pkg/controller/controller_utils.go maxContainerRestarts.
function maxContainerRestarts(pod: k8s.V1Pod): [number, number] {
	let regularRestarts = 0;
	let sidecarRestarts = 0;
	for (const c of pod.status?.containerStatuses ?? []) {
		regularRestarts = Math.max(regularRestarts, c.restartCount ?? 0);
	}
	const names = new Set<string>();
	for (const c of pod.spec?.initContainers ?? []) {
		if (c.restartPolicy === "Always") {
			names.add(c.name);
		}
	}
	for (const c of pod.status?.initContainerStatuses ?? []) {
		if (names.has(c.name)) {
			sidecarRestarts = Math.max(sidecarRestarts, c.restartCount ?? 0);
		}
	}
	return [regularRestarts, sidecarRestarts];
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
