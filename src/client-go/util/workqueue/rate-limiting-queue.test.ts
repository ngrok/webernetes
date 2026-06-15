/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import { Clock } from "../../../clock";
import { browser } from "../../../test/describe";
import {
	Delaying,
	new as newQueue,
	newTypedItemExponentialFailureRateLimiter,
	newTypedRateLimitingQueueWithConfig,
	type WaitFor,
} from "./queue";

browser.describe("rate limiting workqueue", () => {
	// Models staging/src/k8s.io/client-go/util/workqueue/rate_limiting_queue_test.go TestRateLimitingQueue.
	it("RateLimitingQueue", async () => {
		const limiter = newTypedItemExponentialFailureRateLimiter<string>(1, 1000);
		const fakeClock = new Clock();
		fakeClock.pause();
		const delayingQueue = new Delaying(newQueue<string>(), fakeClock);
		const queue = newTypedRateLimitingQueueWithConfig(limiter, { delayingQueue });

		queue.addRateLimited("one");
		let waitEntry = await receiveWaitEntry(delayingQueue);
		expect(waitEntry.readyAt.getTime() - fakeClock.nowMs()).toBe(1);

		queue.addRateLimited("one");
		waitEntry = await receiveWaitEntry(delayingQueue);
		expect(waitEntry.readyAt.getTime() - fakeClock.nowMs()).toBe(2);
		expect(queue.numRequeues("one")).toBe(2);

		queue.addRateLimited("two");
		waitEntry = await receiveWaitEntry(delayingQueue);
		expect(waitEntry.readyAt.getTime() - fakeClock.nowMs()).toBe(1);

		queue.addRateLimited("two");
		waitEntry = await receiveWaitEntry(delayingQueue);
		expect(waitEntry.readyAt.getTime() - fakeClock.nowMs()).toBe(2);

		queue.forget("one");
		expect(queue.numRequeues("one")).toBe(0);
		queue.addRateLimited("one");
		waitEntry = await receiveWaitEntry(delayingQueue);
		expect(waitEntry.readyAt.getTime() - fakeClock.nowMs()).toBe(1);

		await queue.shutDown();
	});
});

async function receiveWaitEntry<T>(delayingQueue: Delaying<T>): Promise<WaitFor<T>> {
	const result = await delayingQueue.waitingForAddCh.receive();
	if (!result.ok) {
		throw new Error("expected wait entry");
	}
	return result.value;
}
