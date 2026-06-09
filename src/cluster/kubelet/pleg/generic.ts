/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { Clock } from "../../../clock";
import { Channel, select, type ReadOnlyChannel } from "../../../go/channel";
import type * as context from "../../../go/context";
import * as time from "../../../go/time";
import { Mutex } from "../../../go/sync/mutex";
import { findContainerByID, findSandboxByID } from "../container";
import type {
	Cache,
	Container as RuntimeContainer,
	ContainerID,
	Pod as RuntimePod,
	PodStatus as PodRuntimeStatus,
	Runtime,
	State as ContainerState,
} from "../container";
import {
	ContainerChanged,
	ContainerDied,
	ContainerRemoved,
	ContainerStarted,
	PodSync,
	type PodLifecycleEventGeneratorHandler,
	type PodLifecycleEvent,
	type RelistDuration,
} from "./pleg";

// Models kubernetes/pkg/kubelet/pleg/generic.go plegContainerState.
type PlegContainerState = "running" | "exited" | "unknown" | "non-existent";

// Models kubernetes/pkg/kubelet/pleg/generic.go relistRequest.
interface RelistRequest {
	podUID: string;
	timestamp: Date;
}

// Models kubernetes/pkg/kubelet/pleg/generic.go podRecord.
export interface PodRecord {
	old?: RuntimePod;
	current?: RuntimePod;
}

// Models kubernetes/pkg/kubelet/pleg/generic.go GenericPLEG.
export class GenericPLEG implements PodLifecycleEventGeneratorHandler {
	readonly podRecords = new PodRecords();
	readonly podsToReinspect = new Set<string>();
	private readonly relistRequests = new Channel<RelistRequest>(200);
	private readonly relistLock = new Mutex();
	private readonly runningMu = new Mutex();
	private stopCh: Channel<void> | undefined;
	globalRelistTimer: time.Timer | undefined;
	private relistTime: Date | undefined;
	private isRunning = false;
	private runPromise: Promise<void> | undefined;

	constructor(
		private readonly runtime: Runtime,
		private readonly eventChannel: Channel<PodLifecycleEvent>,
		public relistDuration: RelistDuration,
		readonly cache: Cache,
		private readonly clock: Clock,
		private readonly ctx: context.Context,
	) {}

	// Models kubernetes/pkg/kubelet/pleg/generic.go Watch.
	watch(): ReadOnlyChannel<PodLifecycleEvent> {
		return this.eventChannel.readOnly();
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go Start.
	async start(): Promise<void> {
		await this.runningMu.withLock(() => {
			if (this.isRunning) {
				return;
			}
			this.isRunning = true;
			this.stopCh = new Channel<void>();
			this.globalRelistTimer = new time.Timer(this.clock, 0);
			this.runPromise = (async () => {
				while (await this.workerLoopIteration()) {
					// Loop body is in workerLoopIteration, matching upstream.
				}
			})();
		});
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go Stop.
	async stop(): Promise<void> {
		let runPromise: Promise<void> | undefined;
		await this.runningMu.withLock(() => {
			if (!this.isRunning) {
				return;
			}
			this.stopCh?.close();
			this.isRunning = false;
			this.globalRelistTimer?.stop();
			runPromise = this.runPromise;
		});
		await runPromise;
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go workerLoopIteration.
	async workerLoopIteration(): Promise<boolean> {
		const stopCh = this.stopCh;
		const globalRelistTimer = this.globalRelistTimer;
		if (!globalRelistTimer) {
			return false;
		}

		const stopped = await select()
			.case(stopCh, () => true)
			.default(() => false);
		if (stopped) {
			return false;
		}

		const relisted = await select()
			.case(globalRelistTimer.C, () => true)
			.default(() => false);
		if (relisted) {
			await this.relist();
			globalRelistTimer.reset(this.relistDuration.relistPeriodMs);
			return true;
		}

		const shouldContinue = await select()
			.case(stopCh, () => false)
			.case(globalRelistTimer.C, async () => {
				await this.relist();
				globalRelistTimer.reset(this.relistDuration.relistPeriodMs);
				return true;
			})
			.case(this.relistRequests, async ({ ok, value }) => {
				if (!ok) {
					return true;
				}
				if (value.timestamp > this.getRelistTime()) {
					await this.relistPod(value.podUID);
				}
				return true;
			});

		return shouldContinue;
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go Update.
	update(relistDuration: RelistDuration): void {
		this.relistDuration = relistDuration;
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go Healthy.
	healthy(): { ok: boolean; error?: Error } {
		const relistTime = this.getRelistTime();
		if (relistTime.getTime() === 0) {
			return { ok: false, error: new Error("pleg has yet to be successful") };
		}
		const elapsed = this.clock.nowMs() - relistTime.getTime();
		if (elapsed > this.relistDuration.relistThresholdMs) {
			return {
				ok: false,
				error: new Error(
					`pleg was last seen active ${elapsed}ms ago; threshold is ${this.relistDuration.relistThresholdMs}ms`,
				),
			};
		}
		return { ok: true };
	}

	getRelistTime(): Date {
		return this.relistTime ?? new Date(0);
	}

	private updateRelistTime(timestamp: Date): void {
		this.relistTime = timestamp;
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go Relist.
	async relist(): Promise<void> {
		await this.relistLock.withLock(async () => {
			const timestamp = this.clock.now();
			const [podList, err] = await this.runtime.getPods(this.ctx, true);
			if (err) {
				return;
			}
			this.updateRelistTime(timestamp);

			this.podRecords.setCurrent(podList);
			for (const pid of this.podRecords.keys()) {
				await this.reconcilePodRecord(pid);
			}

			await this.cache.updateTime(timestamp);
		});
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go reconcilePodRecord.
	private async reconcilePodRecord(pid: string): Promise<void> {
		const oldPod = this.podRecords.getOld(pid);
		const pod = this.podRecords.getCurrent(pid);
		const allContainers = getContainersFromPods(oldPod, pod);
		const events: PodLifecycleEvent[] = [];
		for (const container of allContainers) {
			events.push(...computeEvents(oldPod, pod, container.id));
		}

		const reinspect = this.podsToReinspect.delete(pid);
		if (events.length === 0 && !reinspect) {
			return;
		}

		const [, , error] = await this.updateCache(pod, pid);
		if (error) {
			this.podsToReinspect.add(pid);
			return;
		}

		if (events.length === 0) {
			events.push({ id: pid, type: PodSync });
		}

		this.podRecords.update(pid);

		for (const event of events) {
			if (event.type === ContainerChanged) {
				continue;
			}
			this.eventChannel.trySend(event);
		}
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go relistPod.
	async relistPod(podUID: string): Promise<void> {
		await this.relistLock.withLock(async () => {
			const [pod, err] = await this.runtime.getPod(this.ctx, podUID);
			if (err) {
				return;
			}
			const record = this.podRecords.records.get(podUID);
			if (record) {
				record.current = pod;
			} else {
				this.podRecords.records.set(podUID, { current: pod });
			}
			await this.reconcilePodRecord(podUID);
			await this.cache.setObservedTime(podUID, pod?.timestamp ?? this.clock.now());
		});
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go updateCache.
	private async updateCache(
		pod: RuntimePod | undefined,
		pid: string,
	): Promise<[status: PodRuntimeStatus | undefined, updated: boolean, error: Error | undefined]> {
		if (!pod) {
			await this.cache.delete(pid);
			return [undefined, true, undefined];
		}

		const [status, err] = await this.runtime.getPodStatus(this.ctx, pod);
		if (!err && status) {
			status.ips = await this.getPodIPs(pid, status);
		}

		const updated = await this.cache.set(pod.id, status, err, pod.timestamp);
		return [status, updated, err];
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go getPodIPs.
	private async getPodIPs(pid: string, status: PodRuntimeStatus): Promise<string[]> {
		if (status.ips.length !== 0) {
			return status.ips;
		}

		const [oldStatus, oldStatusErr] = await this.cache.get(pid);
		if (oldStatusErr || !oldStatus || oldStatus.ips.length === 0) {
			return [];
		}

		for (const sandboxStatus of status.sandboxStatuses) {
			if (sandboxStatus.state === "Ready") {
				return status.ips;
			}
		}

		return oldStatus.ips;
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go RequestReinspect.
	requestReinspect(podUID: string): void {
		this.podsToReinspect.add(podUID);
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go RequestRelist.
	requestRelist(podUID: string): void {
		if (!this.relistRequests.trySend({ podUID, timestamp: this.clock.now() })) {
			// Kubernetes logs and drops when the relist request channel is full.
		}
	}
}

// Models kubernetes/pkg/kubelet/pleg/generic.go convertState.
export function convertState(state: ContainerState): PlegContainerState {
	switch (state) {
		case "Created":
			// kubelet doesn't use the "created" state yet, hence convert it to "unknown".
			return "unknown";
		case "Running":
			return "running";
		case "Exited":
			return "exited";
		case "Unknown":
			return "unknown";
	}
	throw new Error(`unrecognized container state: ${state}`);
}

// Models kubernetes/pkg/kubelet/pleg/generic.go generateEvents.
export function generateEvents(
	podID: string,
	cid: string,
	oldState: PlegContainerState,
	newState: PlegContainerState,
): PodLifecycleEvent[] {
	if (newState === oldState) {
		return [];
	}

	switch (newState) {
		case "running":
			return [{ id: podID, type: ContainerStarted, data: cid }];
		case "exited":
			return [{ id: podID, type: ContainerDied, data: cid }];
		case "unknown":
			return [{ id: podID, type: ContainerChanged, data: cid }];
		case "non-existent":
			switch (oldState) {
				case "exited":
					return [{ id: podID, type: ContainerRemoved, data: cid }];
				default:
					return [
						{ id: podID, type: ContainerDied, data: cid },
						{ id: podID, type: ContainerRemoved, data: cid },
					];
			}
	}
	throw new Error(`unrecognized container state: ${newState}`);
}

// Models kubernetes/pkg/kubelet/pleg/generic.go getContainersFromPods.
export function getContainersFromPods(...pods: Array<RuntimePod | undefined>): RuntimeContainer[] {
	const cidSet = new Set<string>();
	const containers: RuntimeContainer[] = [];
	const fillCidSet = (cs: RuntimeContainer[]) => {
		for (const c of cs) {
			const cid = c.id.id;
			if (cidSet.has(cid)) {
				continue;
			}
			cidSet.add(cid);
			containers.push(c);
		}
	};

	for (const p of pods) {
		if (!p) {
			continue;
		}
		fillCidSet(p.containers);
		// Update sandboxes as containers.
		// TODO(upstream): keep track of sandboxes explicitly.
		fillCidSet(p.sandboxes);
	}
	return containers;
}

// Models kubernetes/pkg/kubelet/pleg/generic.go computeEvents.
export function computeEvents(
	oldPod: RuntimePod | undefined,
	newPod: RuntimePod | undefined,
	cid: ContainerID,
): PodLifecycleEvent[] {
	const pid = oldPod?.id ?? newPod?.id ?? "";
	const oldState = getContainerState(oldPod, cid);
	const newState = getContainerState(newPod, cid);
	return generateEvents(pid, cid.id, oldState, newState);
}

// Models kubernetes/pkg/kubelet/pleg/generic.go getContainerState.
export function getContainerState(
	pod: RuntimePod | undefined,
	cid: ContainerID,
): PlegContainerState {
	if (!pod) {
		return "non-existent";
	}
	const container = findContainerByID(pod, cid);
	if (container) {
		return convertState(container.state);
	}
	const sandbox = findSandboxByID(pod, cid);
	if (sandbox) {
		return convertState(sandbox.state);
	}
	return "non-existent";
}

// Models kubernetes/pkg/kubelet/pleg/generic.go podRecords.
export class PodRecords {
	readonly records = new Map<string, PodRecord>();

	keys(): IterableIterator<string> {
		return this.records.keys();
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go podRecords.getOld.
	getOld(id: string): RuntimePod | undefined {
		return this.records.get(id)?.old;
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go podRecords.getCurrent.
	getCurrent(id: string): RuntimePod | undefined {
		return this.records.get(id)?.current;
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go podRecords.setCurrent.
	setCurrent(pods: RuntimePod[]): void {
		for (const record of this.records.values()) {
			record.current = undefined;
		}
		for (const pod of pods) {
			const record = this.records.get(pod.id);
			if (record) {
				record.current = pod;
			} else {
				this.records.set(pod.id, { current: pod });
			}
		}
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go podRecords.update.
	update(id: string): void {
		const record = this.records.get(id);
		if (!record) {
			return;
		}
		this.updateInternal(id, record);
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go podRecords.updateInternal.
	private updateInternal(id: string, record: PodRecord): void {
		if (!record.current) {
			this.records.delete(id);
			return;
		}
		record.old = record.current;
		record.current = undefined;
	}
}
