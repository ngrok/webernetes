/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import * as k8s from "../client";
import { getDeletionCostFromPodAnnotations } from "../apis/core/helper/helpers";
import { safeEncodeString } from "../apimachinery/pkg/util/rand/rand";
import { metaNamespaceKeyFunc } from "../client-go/tools/cache/store";
import * as podutil from "../cluster/api/v1/pod/util";
import * as fnv from "../fnv";
import * as hashutil from "../util/hash/hash";

const podPhaseToOrdinal: Record<string, number> = { Pending: 0, Unknown: 1, Running: 2 };

// Models kubernetes/pkg/controller/controller_utils.go FilterActiveReplicaSets.
export function filterActiveReplicaSets(replicaSets: k8s.V1ReplicaSet[]): k8s.V1ReplicaSet[] {
	return filterReplicaSets(replicaSets, (replicaSet) => (replicaSet.spec?.replicas ?? 0) > 0);
}

// Models kubernetes/pkg/controller/controller_utils.go KeyFunc.
export function keyFunc(obj: k8s.KubernetesObject): [string, Error | undefined] {
	return metaNamespaceKeyFunc(obj);
}

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
