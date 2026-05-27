import type { V1Pod } from "../../../client";
import { deepEqual } from "../../../deep-equal";
import {
	configFirstSeenAnnotationKey,
	configMirrorAnnotationKey,
	configSourceAnnotationKey,
} from "../types/pod-update";

export type CheckAndUpdatePodResult = [
	needUpdate: boolean,
	needReconcile: boolean,
	needGracefulDelete: boolean,
];

const localAnnotations = [
	configSourceAnnotationKey,
	configMirrorAnnotationKey,
	configFirstSeenAnnotationKey,
];

// Models kubernetes/pkg/kubelet/config/config.go checkAndUpdatePod.
export function checkAndUpdatePod(existing: V1Pod, ref: V1Pod): CheckAndUpdatePodResult {
	let needUpdate = false;
	let needReconcile = false;
	let needGracefulDelete = false;

	if (!podsDifferSemantically(existing, ref)) {
		if (!deepEqual(existing.status, ref.status)) {
			existing.status = ref.status;
			needReconcile = true;
		}
		return [needUpdate, needReconcile, needGracefulDelete];
	}

	const refAnnotations = (ref.metadata ??= {}).annotations ?? {};
	refAnnotations[configFirstSeenAnnotationKey] =
		existing.metadata?.annotations?.[configFirstSeenAnnotationKey] ?? "";
	ref.metadata.annotations = refAnnotations;

	existing.spec = ref.spec;
	(existing.metadata ??= {}).labels = ref.metadata?.labels;
	existing.metadata.deletionTimestamp = ref.metadata?.deletionTimestamp;
	existing.metadata.deletionGracePeriodSeconds = ref.metadata?.deletionGracePeriodSeconds;
	existing.metadata.generation = ref.metadata?.generation;
	existing.status = ref.status;
	updateAnnotations(existing, ref);

	if (ref.metadata?.deletionTimestamp !== undefined) {
		needGracefulDelete = true;
	} else {
		needUpdate = true;
	}

	return [needUpdate, needReconcile, needGracefulDelete];
}

// Models kubernetes/pkg/kubelet/config/config.go updateAnnotations.
function updateAnnotations(existing: V1Pod, ref: V1Pod): void {
	const annotations: Record<string, string> = {};
	for (const [key, value] of Object.entries(ref.metadata?.annotations ?? {})) {
		annotations[key] = value;
	}
	for (const key of localAnnotations) {
		const value = existing.metadata?.annotations?.[key];
		if (value !== undefined) {
			annotations[key] = value;
		}
	}
	(existing.metadata ??= {}).annotations = annotations;
}

// Models kubernetes/pkg/kubelet/config/config.go podsDifferSemantically.
function podsDifferSemantically(existing: V1Pod, ref: V1Pod): boolean {
	return !(
		deepEqual(existing.spec, ref.spec) &&
		deepEqual(existing.metadata?.labels ?? {}, ref.metadata?.labels ?? {}) &&
		deepEqual(existing.metadata?.deletionTimestamp, ref.metadata?.deletionTimestamp) &&
		deepEqual(
			existing.metadata?.deletionGracePeriodSeconds,
			ref.metadata?.deletionGracePeriodSeconds,
		) &&
		isAnnotationMapEqual(existing.metadata?.annotations ?? {}, ref.metadata?.annotations ?? {})
	);
}

// Models kubernetes/pkg/kubelet/config/config.go isAnnotationMapEqual.
function isAnnotationMapEqual(
	existingMap: Record<string, string>,
	candidateMap: Record<string, string>,
): boolean {
	for (const [key, value] of Object.entries(candidateMap)) {
		if (isLocalAnnotationKey(key)) {
			continue;
		}
		if (existingMap[key] === value) {
			continue;
		}
		return false;
	}
	for (const key of Object.keys(existingMap)) {
		if (isLocalAnnotationKey(key)) {
			continue;
		}
		if (!(key in candidateMap)) {
			return false;
		}
	}
	return true;
}

// Models kubernetes/pkg/kubelet/config/config.go isLocalAnnotationKey.
function isLocalAnnotationKey(key: string): boolean {
	return localAnnotations.includes(key);
}
