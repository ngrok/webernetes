/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import { getClock } from "../../../clock-context";
import * as context from "../../../go/context";
import { browser } from "../../../test/describe";
import {
	newFakeAlwaysRateLimiter,
	newFakeNeverRateLimiter,
	newTokenBucketRateLimiterWithClock,
} from "./throttle";

browser.describe("flowcontrol throttle", ({ ctx }) => {
	// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle_test.go TestMultithreadedThrottling.
	it("multithreaded throttling", async () => {
		const clock = getClock(ctx);
		const r = newTokenBucketRateLimiterWithClock(100, 1, clock);
		let taken = 0;
		let finished = false;
		let start: () => void = () => {};
		const startCh = new Promise<void>((resolve) => {
			start = resolve;
		});
		let end: () => void = () => {};
		const endCh = new Promise<void>((resolve) => {
			end = resolve;
		});

		for (let i = 0; i < 10; i++) {
			void (async () => {
				await startCh;
				for (;;) {
					await r.accept();
					if (finished) {
						return;
					}
					if (taken < 100) {
						taken++;
						continue;
					}
					finished = true;
					end();
					return;
				}
			})();
		}

		const startTime = Date.now();
		await r.accept();
		start();
		await endCh;
		const endTime = Date.now();

		expect(endTime - startTime).toBeGreaterThanOrEqual(990);
	});

	// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle_test.go TestBasicThrottle.
	it("basic throttle", () => {
		const clock = getClock(ctx);
		clock.pause();
		const r = newTokenBucketRateLimiterWithClock(1, 3, clock);
		for (let i = 0; i < 3; i++) {
			expect(r.tryAccept()).toBe(true);
		}
		expect(r.tryAccept()).toBe(false);
	});

	// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle_test.go TestIncrementThrottle.
	it("increment throttle", () => {
		const clock = getClock(ctx);
		clock.pause();
		const r = newTokenBucketRateLimiterWithClock(1, 1, clock);
		expect(r.tryAccept()).toBe(true);
		expect(r.tryAccept()).toBe(false);

		clock.step(2000);

		expect(r.tryAccept()).toBe(true);
	});

	// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle_test.go TestThrottle.
	it("throttle", async () => {
		const clock = getClock(ctx);
		clock.pause();
		const r = newTokenBucketRateLimiterWithClock(10, 5, clock);
		const expectedFinishMs = clock.nowMs() + 1000;

		for (let i = 0; i < 16; i++) {
			const accepted = r.accept();
			await Promise.resolve();
			if (i >= 5) {
				clock.step(100);
			}
			await accepted;
		}

		expect(clock.nowMs()).toBeGreaterThanOrEqual(expectedFinishMs);
	});

	// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle_test.go TestAlwaysFake.
	it("always fake", async () => {
		const rl = newFakeAlwaysRateLimiter();
		expect(rl.tryAccept()).toBe(true);
		await rl.accept();
	});

	// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle_test.go TestNeverFake.
	it("never fake", async () => {
		const rl = newFakeNeverRateLimiter();
		expect(rl.tryAccept()).toBe(false);

		let finished = false;
		const accepted = rl.accept().then(() => {
			finished = true;
			return undefined;
		});

		await Promise.resolve();
		expect(finished).toBe(false);

		rl.stop();
		await accepted;
		expect(finished).toBe(true);
	});

	// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle_test.go TestWait.
	it("wait", async () => {
		const clock = getClock(ctx);
		const r = newTokenBucketRateLimiterWithClock(0.0001, 1, clock);

		const [childCtx, cancelFn] = context.withTimeout(ctx, 1000);
		const err = await r.wait(childCtx);
		cancelFn();
		expect(err).toBeUndefined();

		const [childCtx2, cancelFn2] = context.withTimeout(ctx, 1000);
		const err2 = await r.wait(childCtx2);
		cancelFn2();
		expect(err2).toBeDefined();
	});

	// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle_test.go fakeClock.
	function newFakeClock(): ReturnType<typeof getClock> {
		const clock = getClock(ctx);
		clock.pause();
		return clock;
	}

	// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle_test.go TestRatePrecisionBug.
	it("rate precision bug", () => {
		const qps = 1000 / 1031.425;
		const clock = newFakeClock();
		const tb = newTokenBucketRateLimiterWithClock(qps, 1, clock);

		for (let i = 0; i < 60; i++) {
			expect(tb.tryAccept(), `failed after ${i * 2} seconds`).toBe(true);
			clock.step(2000);
		}
	});
});
