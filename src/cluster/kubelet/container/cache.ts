import { Channel, select, type ChannelReceive } from "../../../go/channel";
import * as context from "../../../go/context";
import type { PodRuntimeStatus } from "../../cri";

export interface ROCache {
	get(id: string): CacheResult;
	getNewerThan(id: string, minTime: Date): Promise<CacheResult>;
	getNewerThanWithContext(ctx: context.Context, id: string, minTime: Date): Promise<CacheResult>;
}

export interface Cache extends ROCache {
	set(
		id: string,
		status: PodRuntimeStatus | undefined,
		error: Error | undefined,
		timestamp: Date,
	): boolean;
	setObservedTime(id: string, timestamp: Date): void;
	delete(id: string): void;
	updateTime(timestamp: Date): void;
}

export interface CacheResult {
	status: PodRuntimeStatus;
	error: Error | undefined;
}

interface Data {
	status: PodRuntimeStatus;
	error: Error | undefined;
	modified: Date;
	observedTime: Date;
}

interface SubRecord {
	time: Date;
	ch: Channel<Data>;
}

// Models kubernetes/pkg/kubelet/container/cache.go cache.
export class PodStatusCache implements Cache {
	private readonly pods = new Map<string, Data>();
	private readonly subscribers = new Map<string, SubRecord[]>();
	private timestamp: Date | undefined;

	// Models kubernetes/pkg/kubelet/container/cache.go Get.
	get(id: string): CacheResult {
		const data = this.getData(id);
		return { status: data.status, error: data.error };
	}

	// Models kubernetes/pkg/kubelet/container/cache.go GetNewerThan.
	async getNewerThan(id: string, minTime: Date): Promise<CacheResult> {
		const { ch } = this.subscribe(id, minTime);
		return cacheResultFromReceive(id, await ch.receive());
	}

	async getNewerThanWithContext(
		ctx: context.Context,
		id: string,
		minTime: Date,
	): Promise<CacheResult> {
		const subscription = this.subscribe(id, minTime);
		try {
			const selected = await select()
				.case(subscription.ch, (result) => ({ kind: "status" as const, result }))
				.case(ctx.done(), () => ({ kind: "canceled" as const }));
			if (selected.kind === "canceled") {
				throw ctx.err() ?? context.Canceled;
			}
			return cacheResultFromReceive(id, selected.result);
		} finally {
			if (subscription.record) {
				this.unsubscribe(id, subscription.record);
			}
		}
	}

	// Models kubernetes/pkg/kubelet/container/cache.go Set.
	set(
		id: string,
		status: PodRuntimeStatus | undefined,
		error: Error | undefined,
		timestamp: Date,
	): boolean {
		// Kubernetes has Evented PLEG timestamp conflict handling here. The simulator
		// currently models Generic PLEG only.
		this.pods.set(id, {
			status: status ?? makeDefaultStatus(id),
			error,
			modified: timestamp,
			observedTime: timestamp,
		});
		this.notify(id, timestamp);
		return true;
	}

	// Models kubernetes/pkg/kubelet/container/cache.go SetObservedTime.
	setObservedTime(id: string, timestamp: Date): void {
		const data = this.pods.get(id);
		if (data) {
			data.observedTime = timestamp;
		}
		this.notify(id, timestamp);
	}

	// Models kubernetes/pkg/kubelet/container/cache.go Delete.
	delete(id: string): void {
		this.pods.delete(id);
	}

	// Models kubernetes/pkg/kubelet/container/cache.go UpdateTime.
	updateTime(timestamp: Date): void {
		this.timestamp = timestamp;
		for (const id of this.subscribers.keys()) {
			this.notify(id, timestamp);
		}
	}

	private getData(id: string): Data {
		return this.pods.get(id) ?? makeDefaultData(id);
	}

	private getIfNewerThan(id: string, minTime: Date): Data | undefined {
		const data = this.pods.get(id);
		const globalTimestampIsNewer = this.timestamp !== undefined && after(this.timestamp, minTime);
		if (!data && globalTimestampIsNewer) {
			return makeDefaultData(id);
		}
		if (
			data &&
			(globalTimestampIsNewer || after(data.modified, minTime) || after(data.observedTime, minTime))
		) {
			return data;
		}
		return undefined;
	}

	private notify(id: string, timestamp: Date): void {
		const list = this.subscribers.get(id);
		if (!list) {
			return;
		}
		const newList: SubRecord[] = [];
		for (const record of list) {
			if (before(timestamp, record.time)) {
				newList.push(record);
				continue;
			}
			record.ch.trySend(this.getData(id));
			record.ch.close();
		}
		if (newList.length === 0) {
			this.subscribers.delete(id);
		} else {
			this.subscribers.set(id, newList);
		}
	}

	private subscribe(id: string, timestamp: Date): { ch: Channel<Data>; record?: SubRecord } {
		const ch = new Channel<Data>(1);
		const data = this.getIfNewerThan(id, timestamp);
		if (data) {
			ch.trySend(data);
			return { ch };
		}
		const record = {
			time: timestamp,
			ch,
		};
		this.subscribers.set(id, [...(this.subscribers.get(id) ?? []), record]);
		return { ch, record };
	}

	private unsubscribe(id: string, record: SubRecord): void {
		const list = this.subscribers.get(id);
		if (!list) {
			return;
		}
		const newList = list.filter((item) => item !== record);
		if (newList.length === 0) {
			this.subscribers.delete(id);
		} else {
			this.subscribers.set(id, newList);
		}
	}
}

function cacheResultFromReceive(id: string, result: ChannelReceive<Data>): CacheResult {
	if (!result.ok) {
		return { status: makeDefaultStatus(id), error: undefined };
	}
	return { status: result.value.status, error: result.value.error };
}

function makeDefaultData(id: string): Data {
	return {
		status: makeDefaultStatus(id),
		error: undefined,
		modified: new Date(0),
		observedTime: new Date(0),
	};
}

function makeDefaultStatus(id: string): PodRuntimeStatus {
	return {
		id,
		name: "",
		namespace: "default",
		ips: [],
		timestamp: new Date(0),
		containerStatuses: [],
		sandboxStatuses: [],
	};
}

function after(left: Date, right: Date): boolean {
	return left.getTime() > right.getTime();
}

function before(left: Date, right: Date): boolean {
	return left.getTime() < right.getTime();
}
