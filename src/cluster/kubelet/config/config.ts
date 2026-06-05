import type { V1Pod } from "../../../client";
import type { EventRecorder } from "../../../client-go/tools/record/event";
import { failedValidation } from "../events";
import * as kubecontainer from "../container";
import * as format from "../util/format";
import { Clock } from "../../../clock";
import { Channel, type ReadOnlyChannel } from "../../../go/channel";
import type * as context from "../../../go/context";
import { Mutex, RWMutex } from "../../../go/sync/mutex";
import { deepEqual } from "../../../deep-equal";
import {
	configFirstSeenAnnotationKey,
	configMirrorAnnotationKey,
	configSourceAnnotationKey,
	isStaticPod,
	type PodUpdate,
} from "../types/pod-update";
import { Mux, newMux } from "./mux";

// Models kubernetes/pkg/kubelet/config/config.go podStartupSLIObserver.
export interface PodStartupSLIObserver {
	observedPodOnWatch(pod: V1Pod, when: Date): void;
	recordStatusUpdated(pod: V1Pod): void;
	deletePodStartupState(podUid: string): void;
}

// Models kubernetes/pkg/kubelet/config/sources.go SourcesReadyFn.
export type SourcesReadyFn = (sourcesSeen: Set<string>) => boolean;

// Models kubernetes/pkg/kubelet/config/sources.go SourcesReady.
export interface SourcesReady {
	addSource(source: string): void;
	allReady(): boolean;
}

// Models kubernetes/pkg/kubelet/config/sources.go NewSourcesReady.
export function newSourcesReady(sourcesReadyFn: SourcesReadyFn): SourcesReady {
	return new SourcesImpl(sourcesReadyFn);
}

// Models kubernetes/pkg/kubelet/config/sources.go sourcesImpl.
class SourcesImpl implements SourcesReady {
	private readonly sourcesSeen = new Set<string>();

	constructor(private readonly sourcesReadyFn: SourcesReadyFn) {}

	addSource(source: string): void {
		this.sourcesSeen.add(source);
	}

	allReady(): boolean {
		return this.sourcesReadyFn(new Set(this.sourcesSeen));
	}
}

// Models kubernetes/pkg/kubelet/config/config.go sourceUpdate.
export interface SourceUpdate {
	pods: V1Pod[];
}

// Models kubernetes/pkg/kubelet/config/config.go PodConfig.
export class PodConfig {
	private readonly pods: PodStorage;
	private readonly mux: Mux;
	private readonly updateChannel = new Channel<PodUpdate>(50);
	private readonly sources = new Set<string>();

	constructor(recorder: EventRecorder, startupSLIObserver: PodStartupSLIObserver, clock: Clock) {
		this.pods = newPodStorage(this.updateChannel, recorder, startupSLIObserver, clock);
		this.mux = newMux(this.pods);
	}

	// Models kubernetes/pkg/kubelet/config/config.go PodConfig.Channel.
	channel(ctx: context.Context, source: string): Channel<SourceUpdate> {
		this.sources.add(source);
		return this.mux.channelWithContext(ctx, source);
	}

	// Models kubernetes/pkg/kubelet/config/config.go PodConfig.SeenAllSources.
	seenAllSources(seenSources: Set<string>): boolean {
		for (const source of this.sources) {
			if (!seenSources.has(source)) {
				return false;
			}
		}
		return this.pods.seenSources(...this.sources);
	}

	// Models kubernetes/pkg/kubelet/config/config.go PodConfig.Updates.
	updates(): ReadOnlyChannel<PodUpdate> {
		return this.updateChannel.readOnly();
	}
}

// Models kubernetes/pkg/kubelet/config/config.go NewPodConfig.
export function newPodConfig(
	recorder: EventRecorder,
	startupSLIObserver: PodStartupSLIObserver,
	clock: Clock,
): PodConfig {
	return new PodConfig(recorder, startupSLIObserver, clock);
}

// Models kubernetes/pkg/kubelet/config/config.go podStorage.
class PodStorage {
	private readonly podLock = new RWMutex();
	private readonly pods = new Map<string, Map<string, V1Pod>>();
	private readonly updateLock = new Mutex();
	private readonly sourcesSeen = new Set<string>();

	constructor(
		private readonly updateChannel: Channel<PodUpdate>,
		private readonly recorder: EventRecorder,
		private readonly startupSLIObserver: PodStartupSLIObserver,
		private readonly clock: Clock,
	) {}

	// Models kubernetes/pkg/kubelet/config/config.go podStorage.Merge.
	async merge(
		ctx: context.Context,
		source: string,
		update: SourceUpdate,
	): Promise<Error | undefined> {
		return await this.updateLock.withLock(async () => {
			const seenBefore = this.sourcesSeen.has(source);
			const [adds, updates, deletes, removes, reconciles] = await this.mergeInternal(
				ctx,
				source,
				update,
			);
			const firstSet = !seenBefore && this.sourcesSeen.has(source);

			if (removes.pods.length > 0) {
				await this.updateChannel.send(removes);
			}
			if (adds.pods.length > 0) {
				await this.updateChannel.send(adds);
			}
			if (updates.pods.length > 0) {
				await this.updateChannel.send(updates);
			}
			if (deletes.pods.length > 0) {
				await this.updateChannel.send(deletes);
			}
			if (
				firstSet &&
				adds.pods.length === 0 &&
				updates.pods.length === 0 &&
				deletes.pods.length === 0
			) {
				await this.updateChannel.send(adds);
			}
			if (reconciles.pods.length > 0) {
				await this.updateChannel.send(reconciles);
			}

			return undefined;
		});
	}

	// Models kubernetes/pkg/kubelet/config/config.go podStorage.merge.
	private async mergeInternal(
		_ctx: context.Context,
		source: string,
		update: SourceUpdate,
	): Promise<
		[
			adds: PodUpdate,
			updates: PodUpdate,
			deletes: PodUpdate,
			removes: PodUpdate,
			reconciles: PodUpdate,
		]
	> {
		return await this.podLock.withLock(async () => {
			const addPods: V1Pod[] = [];
			const updatePods: V1Pod[] = [];
			const deletePods: V1Pod[] = [];
			const removePods: V1Pod[] = [];
			const reconcilePods: V1Pod[] = [];

			let pods = this.pods.get(source);
			if (!pods) {
				pods = new Map<string, V1Pod>();
			}

			const updatePodsFunc = async (
				newPods: V1Pod[],
				oldPods: Map<string, V1Pod>,
				pods: Map<string, V1Pod>,
			) => {
				const filtered = await filterInvalidPods(newPods, source, this.recorder);
				for (const ref of filtered) {
					const metadata = (ref.metadata ??= {});
					metadata.annotations ??= {};
					metadata.annotations[configSourceAnnotationKey] = source;
					if (!isStaticPod(ref)) {
						this.startupSLIObserver.observedPodOnWatch(ref, this.clock.now());
					}
					const uid = metadata.uid ?? "";
					const existing = oldPods.get(uid);
					if (existing) {
						pods.set(uid, existing);
						const [needUpdate, needReconcile, needGracefulDelete] = checkAndUpdatePod(
							existing,
							ref,
						);
						if (needUpdate) {
							updatePods.push(existing);
						} else if (needReconcile) {
							reconcilePods.push(existing);
						} else if (needGracefulDelete) {
							deletePods.push(existing);
						}
						continue;
					}
					recordFirstSeenTime(ref, this.clock);
					pods.set(uid, ref);
					addPods.push(ref);
				}
			};

			this.markSourceSet(source);
			const oldPods = pods;
			pods = new Map<string, V1Pod>();
			await updatePodsFunc(update.pods, oldPods, pods);
			for (const [uid, existing] of oldPods) {
				if (!pods.has(uid)) {
					removePods.push(existing);
				}
			}

			this.pods.set(source, pods);

			return [
				{ op: "ADD", pods: copyPods(addPods), source },
				{ op: "UPDATE", pods: copyPods(updatePods), source },
				{ op: "DELETE", pods: copyPods(deletePods), source },
				{ op: "REMOVE", pods: copyPods(removePods), source },
				{ op: "RECONCILE", pods: copyPods(reconcilePods), source },
			];
		});
	}

	// Models kubernetes/pkg/kubelet/config/config.go podStorage.markSourceSet.
	private markSourceSet(source: string): void {
		this.sourcesSeen.add(source);
	}

	// Models kubernetes/pkg/kubelet/config/config.go podStorage.seenSources.
	seenSources(...sources: string[]): boolean {
		return sources.every((source) => this.sourcesSeen.has(source));
	}
}

// Models kubernetes/pkg/kubelet/config/config.go newPodStorage.
function newPodStorage(
	updates: Channel<PodUpdate>,
	recorder: EventRecorder,
	startupSLIObserver: PodStartupSLIObserver,
	clock: Clock,
): PodStorage {
	return new PodStorage(updates, recorder, startupSLIObserver, clock);
}

// Models kubernetes/pkg/kubelet/config/config.go filterInvalidPods.
async function filterInvalidPods(
	pods: V1Pod[],
	source: string,
	recorder: EventRecorder,
): Promise<V1Pod[]> {
	const names = new Set<string>();
	const filtered: V1Pod[] = [];
	for (const pod of pods) {
		const name = kubecontainer.getPodFullName(pod);
		if (names.has(name)) {
			await recorder.eventf(
				pod,
				"Warning",
				failedValidation,
				"Error validating pod %s from %s due to duplicate pod name %q, ignoring",
				format.pod(pod),
				source,
				pod.metadata?.name ?? "",
			);
			continue;
		} else {
			names.add(name);
		}
		filtered.push(pod);
	}
	return filtered;
}

// Models kubernetes/pkg/kubelet/config/config.go localAnnotations.
const localAnnotations = [
	configSourceAnnotationKey,
	configMirrorAnnotationKey,
	configFirstSeenAnnotationKey,
];

// Models kubernetes/pkg/kubelet/config/config.go isLocalAnnotationKey.
function isLocalAnnotationKey(key: string): boolean {
	for (const localKey of localAnnotations) {
		if (key === localKey) {
			return true;
		}
	}
	return false;
}

// Models kubernetes/pkg/kubelet/config/config.go isAnnotationMapEqual.
function isAnnotationMapEqual(
	existingMap: Record<string, string>,
	candidateMap: Record<string, string> | undefined,
): boolean {
	if (!candidateMap) {
		candidateMap = {};
	}
	for (const [k, v] of Object.entries(candidateMap)) {
		if (isLocalAnnotationKey(k)) {
			continue;
		}
		if (existingMap[k] === v) {
			continue;
		}
		return false;
	}
	for (const k of Object.keys(existingMap)) {
		if (isLocalAnnotationKey(k)) {
			continue;
		}
		if (!(k in candidateMap)) {
			return false;
		}
	}
	return true;
}

// Models kubernetes/pkg/kubelet/config/config.go recordFirstSeenTime.
function recordFirstSeenTime(pod: V1Pod, clock: Clock): void {
	((pod.metadata ??= {}).annotations ??= {})[configFirstSeenAnnotationKey] = clock
		.now()
		.toISOString();
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
export function podsDifferSemantically(existing: V1Pod, ref: V1Pod): boolean {
	if (
		deepEqual(existing.spec, ref.spec) &&
		deepEqual(existing.metadata?.labels, ref.metadata?.labels) &&
		deepEqual(existing.metadata?.deletionTimestamp, ref.metadata?.deletionTimestamp) &&
		deepEqual(
			existing.metadata?.deletionGracePeriodSeconds,
			ref.metadata?.deletionGracePeriodSeconds,
		) &&
		isAnnotationMapEqual(existing.metadata?.annotations ?? {}, ref.metadata?.annotations)
	) {
		return false;
	}
	return true;
}

// Models kubernetes/pkg/kubelet/config/config.go checkAndUpdatePod.
export function checkAndUpdatePod(
	existing: V1Pod,
	ref: V1Pod,
): [needUpdate: boolean, needReconcile: boolean, needGracefulDelete: boolean] {
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

// Models kubernetes/pkg/kubelet/config/config.go copyPods.
function copyPods(sourcePods: V1Pod[]): V1Pod[] {
	return sourcePods.map((source) => structuredClone(source));
}
