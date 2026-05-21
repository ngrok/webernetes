import type { Clock } from "../../../clock";
import { Channel, select, type ReadOnlyChannel } from "../../../go/channel";
import type * as context from "../../../go/context";
import type { PodRuntimeStatus } from "../../cri";
import type {
	Cache,
	Container as RuntimeContainer,
	Pod as RuntimePod,
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

type PlegContainerState = "running" | "exited" | "unknown" | "non-existent";

interface RelistRequest {
	podUID: string;
	timestamp: Date;
}

interface PodRecord {
	old?: RuntimePod;
	current?: RuntimePod;
}

// Models kubernetes/pkg/kubelet/pleg/generic.go GenericPLEG.
export class GenericPLEG implements PodLifecycleEventGeneratorHandler {
	private readonly podRecords = new PodRecords();
	private readonly podsToReinspect = new Set<string>();
	private readonly relistRequests = new Channel<RelistRequest>(200);
	private stopCh: Channel<void> | undefined;
	private globalRelistTimer: OneShotTimer | undefined;
	private relistTime: Date | undefined;
	private isRunning = false;
	private runPromise: Promise<void> | undefined;

	constructor(
		private readonly runtime: Runtime,
		private readonly eventChannel: Channel<PodLifecycleEvent>,
		private relistDuration: RelistDuration,
		private readonly cache: Cache,
		private readonly clock: Clock,
		private readonly ctx: context.Context,
	) {}

	// Models kubernetes/pkg/kubelet/pleg/generic.go Watch.
	watch(): ReadOnlyChannel<PodLifecycleEvent> {
		return this.eventChannel.readOnly();
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go Start.
	start(): void {
		if (this.isRunning) {
			return;
		}
		this.isRunning = true;
		this.stopCh = new Channel<void>();
		this.globalRelistTimer = new OneShotTimer(this.clock, 0);
		this.runPromise = (async () => {
			while (await this.workerLoopIteration()) {
				// Loop body is in workerLoopIteration, matching upstream.
			}
		})();
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go Stop.
	async stop(): Promise<void> {
		if (!this.isRunning) {
			return;
		}
		this.isRunning = false;
		this.stopCh?.close();
		this.globalRelistTimer?.stop();
		await this.runPromise;
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go workerLoopIteration.
	private async workerLoopIteration(): Promise<boolean> {
		const stopCh = this.stopCh;
		const globalRelistTimer = this.globalRelistTimer;
		if (!stopCh || !globalRelistTimer) {
			return false;
		}

		const stopped = await select()
			.case(stopCh, () => true)
			.default(() => false);
		if (stopped) {
			return false;
		}

		const relisted = await select()
			.case(globalRelistTimer.c, () => true)
			.default(() => false);
		if (relisted) {
			this.relist();
			globalRelistTimer.reset(this.relistDuration.relistPeriodMs);
			return true;
		}

		const selected = await select()
			.case(stopCh, () => "stop" as const)
			.case(globalRelistTimer.c, () => "relist" as const)
			.case(this.relistRequests, ({ ok, value }) => {
				if (!ok) {
					return "request-closed" as const;
				}
				if (after(value.timestamp, this.getRelistTime())) {
					this.relistPod(value.podUID);
				}
				return "request" as const;
			});

		if (selected === "stop") {
			return false;
		}
		if (selected === "relist") {
			this.relist();
			globalRelistTimer.reset(this.relistDuration.relistPeriodMs);
		}
		return true;
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
	relist(): void {
		const timestamp = this.clock.now();
		const podList = this.runtime.getPods(true);
		this.updateRelistTime(timestamp);

		this.podRecords.setCurrent(podList);
		for (const pid of this.podRecords.keys()) {
			this.reconcilePodRecord(pid);
		}

		this.cache.updateTime(timestamp);
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go reconcilePodRecord.
	private reconcilePodRecord(pid: string): void {
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

		const { status, error } = this.updateCache(pod, pid);
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
			if (!this.eventChannel.trySend(event)) {
				return;
			}
			void status;
		}
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go relistPod.
	relistPod(podUID: string): void {
		const [pod, err] = this.runtime.getPod(this.ctx, podUID);
		if (err) {
			this.podsToReinspect.add(podUID);
			return;
		}
		this.podRecords.setPodCurrent(podUID, pod);
		this.reconcilePodRecord(podUID);
		this.cache.setObservedTime(podUID, pod?.timestamp ?? this.clock.now());
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go updateCache.
	private updateCache(
		pod: RuntimePod | undefined,
		pid: string,
	): { status: PodRuntimeStatus | undefined; updated: boolean; error: Error | undefined } {
		if (!pod) {
			this.cache.delete(pid);
			return { status: undefined, updated: true, error: undefined };
		}

		const [status, err] = this.runtime.getPodStatus(this.ctx, pod);
		if (err || !status) {
			return { status: undefined, updated: false, error: err };
		}
		status.ips = this.getPodIPs(pid, status);
		status.ip = status.ips[0];

		const updated = this.cache.set(pod.id, status, undefined, pod.timestamp);
		return { status, updated, error: undefined };
	}

	// Models kubernetes/pkg/kubelet/pleg/generic.go getPodIPs.
	private getPodIPs(pid: string, status: PodRuntimeStatus): string[] {
		if (status.ips.length !== 0) {
			return status.ips;
		}

		const oldStatus = this.cache.get(pid);
		if (oldStatus.error || oldStatus.status.ips.length === 0) {
			return [];
		}

		for (const sandboxStatus of status.sandboxStatuses) {
			if (sandboxStatus.state === "Ready") {
				return status.ips;
			}
		}

		return oldStatus.status.ips;
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
}

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
}

export function getContainersFromPods(...pods: Array<RuntimePod | undefined>): RuntimeContainer[] {
	const cidSet = new Set<string>();
	const containers: RuntimeContainer[] = [];
	const fillCidSet = (candidates: RuntimeContainer[]) => {
		for (const container of candidates) {
			if (cidSet.has(container.id)) {
				continue;
			}
			cidSet.add(container.id);
			containers.push(container);
		}
	};

	for (const pod of pods) {
		if (!pod) {
			continue;
		}
		fillCidSet(pod.containers);
		// Update sandboxes as containers.
		// TODO(upstream): keep track of sandboxes explicitly.
		fillCidSet(pod.sandboxes);
	}
	return containers;
}

export function computeEvents(
	oldPod: RuntimePod | undefined,
	newPod: RuntimePod | undefined,
	cid: string,
): PodLifecycleEvent[] {
	const pid = oldPod?.id ?? newPod?.id ?? "";
	const oldState = getContainerState(oldPod, cid);
	const newState = getContainerState(newPod, cid);
	return generateEvents(pid, cid, oldState, newState);
}

export function getContainerState(pod: RuntimePod | undefined, cid: string): PlegContainerState {
	if (!pod) {
		return "non-existent";
	}
	const container = pod.containers.find((candidate) => candidate.id === cid);
	if (container) {
		return convertState(container.state);
	}
	const sandbox = pod.sandboxes.find((candidate) => candidate.id === cid);
	if (sandbox) {
		return convertState(sandbox.state);
	}
	return "non-existent";
}

class PodRecords {
	private readonly records = new Map<string, PodRecord>();

	keys(): IterableIterator<string> {
		return this.records.keys();
	}

	getOld(id: string): RuntimePod | undefined {
		return this.records.get(id)?.old;
	}

	getCurrent(id: string): RuntimePod | undefined {
		return this.records.get(id)?.current;
	}

	setCurrent(pods: RuntimePod[]): void {
		for (const record of this.records.values()) {
			record.current = undefined;
		}
		for (const pod of pods) {
			this.setPodCurrent(pod.id, pod);
		}
	}

	setPodCurrent(id: string, pod: RuntimePod | undefined): void {
		const record = this.records.get(id);
		if (record) {
			record.current = pod;
		} else {
			this.records.set(id, { current: pod });
		}
	}

	update(id: string): void {
		const record = this.records.get(id);
		if (!record) {
			return;
		}
		this.updateInternal(id, record);
	}

	private updateInternal(id: string, record: PodRecord): void {
		if (!record.current) {
			this.records.delete(id);
			return;
		}
		record.old = record.current;
		record.current = undefined;
	}
}

class OneShotTimer {
	private readonly ticks = new Channel<Date>(1);
	private handle: number | undefined;
	readonly c: ReadOnlyChannel<Date> = this.ticks.readOnly();

	constructor(
		private readonly clock: Clock,
		delayMs: number,
	) {
		this.reset(delayMs);
	}

	stop(): void {
		if (this.handle !== undefined) {
			this.clock.clearTimeout(this.handle);
			this.handle = undefined;
		}
		this.ticks.drainBuffered();
	}

	reset(delayMs: number): void {
		this.stop();
		this.handle = this.clock.setTimeout(() => {
			this.handle = undefined;
			this.ticks.trySend(this.clock.now());
		}, delayMs);
	}
}

function after(left: Date, right: Date): boolean {
	return left.getTime() > right.getTime();
}
