/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import { Channel, select } from "../../../go/channel";
import { browser } from "../../../test/describe";
import {
	defaultQueue,
	new as newQueue,
	newWithConfig,
	type Queue,
	type TypedInterface,
} from "./queue";

class TraceQueue<T> implements Queue<T> {
	touched = new Set<T>();

	constructor(readonly queue: Queue<T>) {}

	touch(item: T): void {
		this.queue.touch(item);
		this.touched.add(item);
	}

	push(item: T): void {
		this.queue.push(item);
	}

	len(): number {
		return this.queue.len();
	}

	pop(): T {
		return this.queue.pop();
	}
}

browser.describe("workqueue", () => {
	// Models staging/src/k8s.io/client-go/util/workqueue/queue_test.go TestBasic.
	it("Basic", async () => {
		const tests: Array<{
			queue: TypedInterface<number | string>;
			queueShutDown: (queue: TypedInterface<number | string>) => void | Promise<void>;
		}> = [
			{
				queue: newQueue<number | string>(),
				queueShutDown: (queue) => queue.shutDown(),
			},
			{
				queue: newQueue<number | string>(),
				queueShutDown: (queue) => queue.shutDownWithDrain(),
			},
		];
		for (const test of tests) {
			const producers: Array<Promise<void>> = [];
			for (let i = 0; i < 50; i++) {
				producers.push(
					(async () => {
						for (let j = 0; j < 50; j++) {
							test.queue.add(i);
							await sleep(1);
						}
					})(),
				);
			}

			const gotAddedAfterShutdown: Array<number | string> = [];
			const consumers: Array<Promise<void>> = [];
			for (let i = 0; i < 10; i++) {
				consumers.push(
					(async () => {
						while (true) {
							const [item, quit] = await test.queue.get();
							if (item === "added after shutdown!") {
								gotAddedAfterShutdown.push(item);
							}
							if (quit) {
								return;
							}
							await sleep(3);
							test.queue.done(item as number | string);
						}
					})(),
				);
			}

			await Promise.all(producers);
			await Promise.resolve(test.queueShutDown(test.queue));
			test.queue.add("added after shutdown!");
			await Promise.all(consumers);

			expect(gotAddedAfterShutdown).toEqual([]);
			expect(test.queue.len()).toBe(0);
		}
	});

	// Models staging/src/k8s.io/client-go/util/workqueue/queue_test.go TestAddWhileProcessing.
	it("AddWhileProcessing", async () => {
		const tests: Array<{
			queue: TypedInterface<number>;
			queueShutDown: (queue: TypedInterface<number>) => void | Promise<void>;
		}> = [
			{
				queue: newQueue<number>(),
				queueShutDown: (queue) => queue.shutDown(),
			},
			{
				queue: newQueue<number>(),
				queueShutDown: (queue) => queue.shutDownWithDrain(),
			},
		];
		for (const test of tests) {
			const producers: Array<Promise<void>> = [];
			for (let i = 0; i < 50; i++) {
				producers.push(
					(async () => {
						test.queue.add(i);
					})(),
				);
			}

			const consumers: Array<Promise<void>> = [];
			for (let i = 0; i < 10; i++) {
				consumers.push(
					(async () => {
						const counters = new Map<number, number>();
						while (true) {
							const [item, quit] = await test.queue.get();
							if (quit) {
								return;
							}
							const key = item as number;
							const count = (counters.get(key) ?? 0) + 1;
							counters.set(key, count);
							if (count < 2) {
								test.queue.add(key);
							}
							test.queue.done(key);
						}
					})(),
				);
			}

			await Promise.all(producers);
			await Promise.resolve(test.queueShutDown(test.queue));
			await Promise.all(consumers);
			expect(test.queue.len()).toBe(0);
		}
	});

	// Models staging/src/k8s.io/client-go/util/workqueue/queue_test.go TestLen.
	it("Len", () => {
		const q = newQueue<string>();
		q.add("foo");
		expect(q.len()).toBe(1);
		q.add("bar");
		expect(q.len()).toBe(2);
		q.add("foo");
		expect(q.len()).toBe(2);
	});

	// Models staging/src/k8s.io/client-go/util/workqueue/queue_test.go TestReinsert.
	it("Reinsert", async () => {
		const q = newQueue<string>();
		q.add("foo");

		let [item] = await q.get();
		expect(item).toBe("foo");

		q.add(item as string);
		q.done(item as string);

		[item] = await q.get();
		expect(item).toBe("foo");

		q.done(item as string);
		expect(q.len()).toBe(0);
	});

	// Models staging/src/k8s.io/client-go/util/workqueue/queue_test.go TestCollapse.
	it("Collapse", async () => {
		const tq = new TraceQueue(defaultQueue<unknown>());
		const q = newWithConfig({ name: "", queue: tq });

		q.add("bar");
		q.add("bar");

		const [item] = await q.get();
		expect(item).toBe("bar");
		q.done(item as string);

		expect(q.len()).toBe(0);
		expect(tq.touched.has("bar")).toBe(true);
	});

	// Models staging/src/k8s.io/client-go/util/workqueue/queue_test.go TestCollapseWhileProcessing.
	it("CollapseWhileProcessing", async () => {
		const tq = new TraceQueue(defaultQueue<unknown>());
		const q = newWithConfig({ name: "", queue: tq });
		q.add("foo");

		const [item] = await q.get();
		expect(item).toBe("foo");

		q.add("foo");
		q.add("foo");

		const waitCh = new Channel<void>();
		const worker = (async () => {
			try {
				const [workerItem] = await q.get();
				expect(workerItem).toBe("foo");
				q.done(workerItem as string);
			} finally {
				waitCh.close();
			}
		})();

		await sleep(100);
		const workerFinished = await select()
			.case(waitCh, () => true)
			.default(() => false);
		if (workerFinished) {
			throw new Error("worker should be blocked until we are done");
		}
		q.done("foo");

		await waitCh.receive();
		await worker;

		expect(q.len()).toBe(0);
		expect(tq.touched.has("foo")).toBe(false);
	});

	// Models staging/src/k8s.io/client-go/util/workqueue/queue_test.go TestQueueDrainageUsingShutDownWithDrain.
	it("QueueDrainageUsingShutDownWithDrain", async () => {
		const q = newQueue<string>();
		q.add("foo");
		q.add("bar");

		const [firstItem] = await q.get();
		const [secondItem] = await q.get();
		let finished = false;
		const finishedPromise = (async () => {
			await q.shutDownWithDrain();
			finished = true;
		})();

		const [, shuttingDown] = await q.get();
		expect(shuttingDown).toBe(true);
		expect(finished).toBe(false);

		q.done(firstItem as string);
		q.done(secondItem as string);
		await finishedPromise;
		expect(finished).toBe(true);
	});

	// Models staging/src/k8s.io/client-go/util/workqueue/queue_test.go TestNoQueueDrainageUsingShutDown.
	it("NoQueueDrainageUsingShutDown", async () => {
		const q = newQueue<string>();
		q.add("foo");
		q.add("bar");

		await q.get();
		await q.get();

		const finishedPromise = (async () => {
			await q.shutDown();
		})();

		await finishedPromise;
	});

	// Models staging/src/k8s.io/client-go/util/workqueue/queue_test.go TestForceQueueShutdownUsingShutDown.
	it("ForceQueueShutdownUsingShutDown", async () => {
		const q = newQueue<string>();
		q.add("foo");
		q.add("bar");

		await q.get();
		await q.get();
		let finished = false;
		const finishedPromise = (async () => {
			await q.shutDownWithDrain();
			finished = true;
		})();

		const [, shuttingDown] = await q.get();
		expect(shuttingDown).toBe(true);
		expect(finished).toBe(false);

		await q.shutDown();
		await finishedPromise;
		expect(finished).toBe(true);
	});

	// Models staging/src/k8s.io/client-go/util/workqueue/queue_test.go TestQueueDrainageUsingShutDownWithDrainWithDirtyItem.
	it("QueueDrainageUsingShutDownWithDrainWithDirtyItem", async () => {
		const q = newQueue<string>();
		q.add("foo");
		const [gotten] = await q.get();
		q.add("foo");

		const finishedPromise = q.shutDownWithDrain();
		let [, shuttingDown] = await q.get();
		expect(shuttingDown).toBe(true);

		q.done(gotten as string);

		const [again, againShuttingDown] = await q.get();
		expect(againShuttingDown).toBe(false);
		q.done(again as string);

		[, shuttingDown] = await q.get();
		expect(shuttingDown).toBe(true);
		await finishedPromise;
	});
});

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
