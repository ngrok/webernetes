import { Channel, select, type ChannelReceive } from "../../../go/channel";
import * as context from "../../../go/context";
import { RWMutex } from "../../../go/sync/mutex";
import { newPodStatus, type PodStatus } from "./runtime";

// Models kubernetes/pkg/kubelet/container/cache.go ROCache.
export interface ROCache {
	get(id: string): Promise<PodStatusResult>;
	// Upstream GetNewerThan does not take a context because goroutine cancellation
	// can interrupt callers. The simulator awaits this method directly, so the
	// context keeps pod workers cancellable while waiting for a fresher status.
	getNewerThan(ctx: context.Context, id: string, minTime: Date): Promise<PodStatusResult>;
}

// Models kubernetes/pkg/kubelet/container/cache.go Cache.
export interface Cache extends ROCache {
	set(
		id: string,
		status: PodStatus | undefined,
		error: Error | undefined,
		timestamp: Date,
	): Promise<boolean>;
	setObservedTime(id: string, timestamp: Date): Promise<void>;
	delete(id: string): Promise<void>;
	updateTime(timestamp: Date): Promise<void>;
}

export type PodStatusResult = [status: PodStatus | undefined, err: Error | undefined];

// Models kubernetes/pkg/kubelet/container/cache.go data.
interface Data {
	status: PodStatus | undefined;
	error: Error | undefined;
	modified: Date;
	observedTime: Date;
}

// Models kubernetes/pkg/kubelet/container/cache.go subRecord.
interface SubRecord {
	time: Date;
	ch: Channel<Data>;
}

// Models kubernetes/pkg/kubelet/container/cache.go cache.
export class PodStatusCache implements Cache {
	private readonly lock = new RWMutex();
	private readonly pods = new Map<string, Data>();
	private timestamp: Date | undefined;
	private readonly subscribers = new Map<string, SubRecord[]>();

	// Models kubernetes/pkg/kubelet/container/cache.go Get.
	async get(id: string): Promise<PodStatusResult> {
		return await this.lock.withRLock(() => {
			const data = this.getData(id);
			return [data.status, data.error];
		});
	}

	// Models kubernetes/pkg/kubelet/container/cache.go GetNewerThan.
	async getNewerThan(ctx: context.Context, id: string, minTime: Date): Promise<PodStatusResult> {
		const subscription = await this.subscribe(id, minTime);
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
				await this.unsubscribe(id, subscription.record);
			}
		}
	}

	// Models kubernetes/pkg/kubelet/container/cache.go Set.
	set(
		id: string,
		status: PodStatus | undefined,
		error: Error | undefined,
		timestamp: Date,
	): Promise<boolean> {
		return this.lock.withLock(() => {
			// Kubernetes has Evented PLEG timestamp conflict handling here. The simulator
			// currently models Generic PLEG only.
			this.pods.set(id, {
				status,
				error,
				modified: timestamp,
				observedTime: timestamp,
			});
			this.notify(id, timestamp);
			return true;
		});
	}

	// Models kubernetes/pkg/kubelet/container/cache.go SetObservedTime.
	async setObservedTime(id: string, timestamp: Date): Promise<void> {
		await this.lock.withLock(() => {
			const data = this.pods.get(id);
			if (data) {
				data.observedTime = timestamp;
			}
			this.notify(id, timestamp);
		});
	}

	// Models kubernetes/pkg/kubelet/container/cache.go Delete.
	async delete(id: string): Promise<void> {
		await this.lock.withLock(() => {
			this.pods.delete(id);
		});
	}

	// Models kubernetes/pkg/kubelet/container/cache.go UpdateTime.
	async updateTime(timestamp: Date): Promise<void> {
		await this.lock.withLock(() => {
			this.timestamp = timestamp;
			for (const id of this.subscribers.keys()) {
				this.notify(id, timestamp);
			}
		});
	}

	// Models kubernetes/pkg/kubelet/container/cache.go get.
	private getData(id: string): Data {
		return this.pods.get(id) ?? makeDefaultData(id);
	}

	// Models kubernetes/pkg/kubelet/container/cache.go getIfNewerThan.
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

	// Models kubernetes/pkg/kubelet/container/cache.go notify.
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

	// Models kubernetes/pkg/kubelet/container/cache.go subscribe.
	private async subscribe(
		id: string,
		timestamp: Date,
	): Promise<{ ch: Channel<Data>; record?: SubRecord }> {
		return await this.lock.withLock(() => {
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
		});
	}

	// Simulator cancellation cleanup for GetNewerThan.
	private async unsubscribe(id: string, record: SubRecord): Promise<void> {
		await this.lock.withLock(() => {
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
		});
	}
}

// Simulator adapter for cancellable channel receive.
function cacheResultFromReceive(id: string, result: ChannelReceive<Data>): PodStatusResult {
	if (!result.ok) {
		return [makeDefaultStatus(id), undefined];
	}
	return [result.value.status, result.value.error];
}

// Models kubernetes/pkg/kubelet/container/cache.go makeDefaultData.
function makeDefaultData(id: string): Data {
	return {
		status: makeDefaultStatus(id),
		error: undefined,
		modified: new Date(0),
		observedTime: new Date(0),
	};
}

// Models kubernetes/pkg/kubelet/container/cache.go makeDefaultData PodStatus literal.
function makeDefaultStatus(id: string): PodStatus {
	return newPodStatus({ id });
}

// Models time.Time.After.
function after(left: Date, right: Date): boolean {
	return left.getTime() > right.getTime();
}

// Models time.Time.Before.
function before(left: Date, right: Date): boolean {
	return left.getTime() < right.getTime();
}
