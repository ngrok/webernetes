/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { Clock } from "../../../clock";
import { withClock } from "../../../clock-context";
import { Channel, select } from "../../../go/channel";
import * as heap from "../../../go/container/heap/heap";
import * as context from "../../../go/context";
import { Once } from "../../../go/sync/once";
import { Ticker, Timer } from "../../../go/time";
import { newTyped, Typed, type TypedInterface } from "./queue";

// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go TypedDelayingInterface.
export interface TypedDelayingInterface<T> extends TypedInterface<T> {
	addAfter(item: T, durationMs: number): Promise<void>;
}

// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go waitFor.
export interface WaitFor<T> {
	data: T;
	readyAt: Date;
	index: number;
}

// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go TypedDelayingQueueConfig.
export interface TypedDelayingQueueConfig<T> {
	name?: string;
	clock?: Clock;
	queue?: TypedInterface<T>;
}

// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go delayingType.
export class Delaying<T> implements TypedDelayingInterface<T> {
	private readonly queue: TypedInterface<T>;
	private readonly clock: Clock;
	private readonly ctx: context.Context;
	private readonly heartbeat: Ticker;
	private readonly stopCh = new Channel<void>();
	private readonly stopOnce = new Once();
	readonly waitingForAddCh = new Channel<WaitFor<T>>(1000);

	// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go newDelayingQueue.
	constructor(
		queue: TypedInterface<T> = new Typed<T>(),
		clock: Clock = new Clock(),
		startWaitingLoop = false,
	) {
		this.queue = queue;
		this.clock = clock;
		this.ctx = withClock(context.background(), clock);
		this.heartbeat = new Ticker(this.ctx, maxWaitMs);
		if (startWaitingLoop) {
			void this.waitingLoop();
		}
	}

	add(item: T): void {
		this.queue.add(item);
	}

	// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go AddAfter.
	async addAfter(item: T, durationMs: number): Promise<void> {
		if (this.shuttingDown()) {
			return;
		}
		if (durationMs <= 0) {
			this.add(item);
			return;
		}

		const entry: WaitFor<T> = {
			data: item,
			readyAt: new Date(this.clock.nowMs() + durationMs),
			index: -1,
		};
		await select()
			.receive(this.stopCh, () => undefined)
			.send(this.waitingForAddCh, entry, () => undefined);
	}

	len(): number {
		return this.queue.len();
	}

	async get(): Promise<[item: T | undefined, shutdown: boolean]> {
		return await this.queue.get();
	}

	done(item: T): void {
		this.queue.done(item);
	}

	// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go ShutDown.
	async shutDown(): Promise<void> {
		await this.stopOnce.do(async () => {
			await this.queue.shutDown();
			this.stopCh.close();
			this.heartbeat.stop();
		});
	}

	async shutDownWithDrain(): Promise<void> {
		await this.queue.shutDownWithDrain();
	}

	shuttingDown(): boolean {
		return this.queue.shuttingDown();
	}

	// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go waitingLoop.
	private async waitingLoop(): Promise<void> {
		let nextReadyAtTimer: Timer | undefined;
		const waitingForQueue = new WaitForPriorityQueue<T>();
		const waitingEntryByData = new Map<T, WaitFor<T>>();

		for (;;) {
			if (this.queue.shuttingDown()) {
				nextReadyAtTimer?.stop();
				return;
			}

			const now = this.clock.now();
			while (waitingForQueue.len() > 0) {
				let entry = waitingForQueue.peek();
				if (entry.readyAt > now) {
					break;
				}

				entry = heap.pop(waitingForQueue);
				this.add(entry.data);
				waitingEntryByData.delete(entry.data);
			}

			let nextReadyAt = undefined;
			if (waitingForQueue.len() > 0) {
				nextReadyAtTimer?.stop();
				const entry = waitingForQueue.peek();
				nextReadyAtTimer = new Timer(this.ctx, entry.readyAt.getTime() - now.getTime());
				nextReadyAt = nextReadyAtTimer.C;
			}

			const selected = await select()
				.receive(this.stopCh, () => "stop" as const)
				.receive(this.heartbeat.C, () => "heartbeat" as const)
				.receive(nextReadyAt, () => "ready" as const)
				.receive(this.waitingForAddCh, (result) => {
					if (!result.ok) {
						return "stop" as const;
					}
					return result.value;
				});

			if (selected === "stop") {
				nextReadyAtTimer?.stop();
				return;
			}
			if (selected === "heartbeat" || selected === "ready") {
				continue;
			}

			if (selected.readyAt > this.clock.now()) {
				insert(waitingForQueue, waitingEntryByData, selected);
			} else {
				this.add(selected.data);
			}

			for (;;) {
				const result = this.waitingForAddCh.tryReceive();
				if (!result) {
					break;
				}
				if (!result.ok) {
					nextReadyAtTimer?.stop();
					return;
				}
				const waitEntry = result.value;
				if (waitEntry.readyAt > this.clock.now()) {
					insert(waitingForQueue, waitingEntryByData, waitEntry);
				} else {
					this.add(waitEntry.data);
				}
			}
		}
	}
}

// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go maxWait.
const maxWaitMs = 10_000;

// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go waitForPriorityQueue.
export class WaitForPriorityQueue<T> implements heap.Interface<WaitFor<T>> {
	private readonly entries: Array<WaitFor<T>> = [];

	// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go Len.
	len(): number {
		return this.entries.length;
	}

	// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go Less.
	less(i: number, j: number): boolean {
		return this.entries[i].readyAt < this.entries[j].readyAt;
	}

	// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go Swap.
	swap(i: number, j: number): void {
		const left = this.entries[i] as WaitFor<T>;
		const right = this.entries[j] as WaitFor<T>;
		this.entries[i] = right;
		this.entries[j] = left;
		this.entries[i].index = i;
		this.entries[j].index = j;
	}

	// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go Push.
	push(item: WaitFor<T>): void {
		const n = this.entries.length;
		item.index = n;
		this.entries.push(item);
	}

	// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go Pop.
	pop(): WaitFor<T> {
		const item = this.entries.pop();
		if (!item) {
			throw new Error("pop from empty priority queue");
		}
		item.index = -1;
		return item;
	}

	// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go Peek.
	peek(): WaitFor<T> {
		const entry = this.entries[0];
		if (!entry) {
			throw new Error("peek from empty priority queue");
		}
		return entry;
	}
}

// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go insert.
function insert<T>(
	queue: WaitForPriorityQueue<T>,
	knownEntries: Map<T, WaitFor<T>>,
	entry: WaitFor<T>,
) {
	const existing = knownEntries.get(entry.data);
	if (existing) {
		if (existing.readyAt > entry.readyAt) {
			existing.readyAt = entry.readyAt;
			heap.fix(queue, existing.index);
		}
		return;
	}

	heap.push(queue, entry);
	knownEntries.set(entry.data, entry);
}

// Models staging/src/k8s.io/client-go/util/workqueue/delaying_queue.go NewTypedDelayingQueueWithConfig.
export function newTypedDelayingQueueWithConfig<T>(
	config: TypedDelayingQueueConfig<T> = {},
): TypedDelayingInterface<T> {
	return new Delaying<T>(config.queue ?? newTyped<T>(), config.clock ?? new Clock(), true);
}
