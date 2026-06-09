/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { Clock } from "../../../clock";
import { select } from "../../../go/channel";
import type * as context from "../../../go/context";

// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle.go PassiveRateLimiter.
export interface PassiveRateLimiter {
	tryAccept(): boolean;
	stop(): void;
	qps(): number;
}

// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle.go RateLimiter.
export interface RateLimiter extends PassiveRateLimiter {
	accept(): Promise<void>;
	wait(ctx: context.Context): Promise<Error | undefined>;
}

// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle.go tokenBucketPassiveRateLimiter.
class TokenBucketPassiveRateLimiter implements PassiveRateLimiter {
	private tokens: number;
	private lastRefillMs: number;

	constructor(
		private readonly qpsValue: number,
		private readonly burst: number,
		protected readonly clock: Clock,
	) {
		this.tokens = burst;
		this.lastRefillMs = clock.nowMs();
	}

	// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle.go tokenBucketPassiveRateLimiter.Stop.
	stop(): void {}

	// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle.go tokenBucketPassiveRateLimiter.QPS.
	qps(): number {
		return this.qpsValue;
	}

	// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle.go tokenBucketPassiveRateLimiter.TryAccept.
	tryAccept(): boolean {
		this.refill();
		if (this.tokens >= 1) {
			this.tokens -= 1;
			return true;
		}
		return false;
	}

	protected delayUntilNextTokenMs(): number {
		this.refill();
		if (this.tokens >= 1) {
			return 0;
		}
		return ((1 - this.tokens) / this.qpsValue) * 1000;
	}

	private refill(): void {
		const nowMs = this.clock.nowMs();
		const elapsedMs = Math.max(0, nowMs - this.lastRefillMs);
		this.lastRefillMs = nowMs;
		this.tokens = Math.min(this.burst, this.tokens + (elapsedMs / 1000) * this.qpsValue);
	}
}

// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle.go tokenBucketRateLimiter.
class TokenBucketRateLimiter extends TokenBucketPassiveRateLimiter implements RateLimiter {
	// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle.go tokenBucketRateLimiter.Accept.
	async accept(): Promise<void> {
		for (;;) {
			if (this.tryAccept()) {
				return;
			}
			await this.clock.wait(this.delayUntilNextTokenMs());
		}
	}

	// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle.go tokenBucketRateLimiter.Wait.
	async wait(ctx: context.Context): Promise<Error | undefined> {
		for (;;) {
			if (this.tryAccept()) {
				return undefined;
			}
			const selected = await select()
				.case(ctx.done(), () => ({ kind: "done" as const }))
				.default(() => ({ kind: "wait" as const }));
			if (selected.kind === "done") {
				return ctx.err();
			}
			const delayMs = this.delayUntilNextTokenMs();
			const waitResult = await Promise.race([
				this.clock.wait(delayMs).then(() => ({ kind: "timer" as const })),
				ctx
					.done()
					.receive()
					.then(() => ({ kind: "done" as const })),
			]);
			if (waitResult.kind === "done") {
				return ctx.err();
			}
		}
	}
}

// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle.go NewTokenBucketRateLimiter.
export function newTokenBucketRateLimiter(qps: number, burst: number): RateLimiter {
	return newTokenBucketRateLimiterWithClock(qps, burst, new Clock());
}

// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle.go NewTokenBucketPassiveRateLimiter.
export function newTokenBucketPassiveRateLimiter(qps: number, burst: number): PassiveRateLimiter {
	return newTokenBucketPassiveRateLimiterWithClock(qps, burst, new Clock());
}

// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle.go NewTokenBucketRateLimiterWithClock.
export function newTokenBucketRateLimiterWithClock(
	qps: number,
	burst: number,
	clock: Clock,
): RateLimiter {
	return new TokenBucketRateLimiter(qps, burst, clock);
}

// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle.go NewTokenBucketPassiveRateLimiterWithClock.
export function newTokenBucketPassiveRateLimiterWithClock(
	qps: number,
	burst: number,
	clock: Clock,
): PassiveRateLimiter {
	return new TokenBucketPassiveRateLimiter(qps, burst, clock);
}

// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle.go fakeAlwaysRateLimiter.
class FakeAlwaysRateLimiter implements RateLimiter {
	tryAccept(): boolean {
		return true;
	}

	stop(): void {}

	async accept(): Promise<void> {}

	qps(): number {
		return 1;
	}

	async wait(_ctx: context.Context): Promise<Error | undefined> {
		return undefined;
	}
}

// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle.go NewFakeAlwaysRateLimiter.
export function newFakeAlwaysRateLimiter(): RateLimiter {
	return new FakeAlwaysRateLimiter();
}

// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle.go fakeNeverRateLimiter.
class FakeNeverRateLimiter implements RateLimiter {
	private stopped = false;
	private readonly waiters: Array<() => void> = [];

	tryAccept(): boolean {
		return false;
	}

	stop(): void {
		this.stopped = true;
		for (const waiter of this.waiters.splice(0)) {
			waiter();
		}
	}

	async accept(): Promise<void> {
		if (this.stopped) {
			return;
		}
		await new Promise<void>((resolve) => {
			this.waiters.push(resolve);
		});
	}

	qps(): number {
		return 1;
	}

	async wait(_ctx: context.Context): Promise<Error | undefined> {
		return new Error("can not be accept");
	}
}

// Models staging/src/k8s.io/client-go/util/flowcontrol/throttle.go NewFakeNeverRateLimiter.
export function newFakeNeverRateLimiter(): RateLimiter {
	return new FakeNeverRateLimiter();
}
