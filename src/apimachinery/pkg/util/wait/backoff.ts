/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { Clock } from "../../../../clock";
import { getClock } from "../../../../clock-context";
import { select } from "../../../../go/channel";
import * as context from "../../../../go/context";
import type { MaybePromise } from "../../../../promise";
import { DelayFunc } from "./delay";
import {
	FixedTimer,
	newNoopTimer,
	realTicker,
	realTimer,
	type Timer,
	VariableTimer,
} from "./timer";
import { jitter as jitterDuration } from "./wait";

export type FuncWithContext = (ctx: context.Context) => MaybePromise<void>;

export interface BackoffOptions {
	durationMs?: number;
	factor?: number;
	jitter?: number;
	steps?: number;
	capMs?: number;
}

// Models staging/src/k8s.io/apimachinery/pkg/util/wait/backoff.go Backoff.
export class Backoff {
	private readonly ctx: context.Context;
	durationMs: number;
	factor: number;
	jitter: number;
	steps: number;
	capMs: number;

	constructor(ctx: context.Context, options: BackoffOptions = {}) {
		this.ctx = ctx;
		this.durationMs = options.durationMs ?? 0;
		this.factor = options.factor ?? 0;
		this.jitter = options.jitter ?? 0;
		this.steps = options.steps ?? 0;
		this.capMs = options.capMs ?? 0;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/backoff.go Backoff.Step.
	step(): number {
		const [nextDuration, next, nextSteps] = delay(
			this.steps,
			this.durationMs,
			this.capMs,
			this.factor,
			this.jitter,
		);
		this.durationMs = next;
		this.steps = nextSteps;
		return nextDuration;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/backoff.go Backoff.DelayFunc.
	delayFunc(): DelayFunc {
		let steps = this.steps;
		let durationMs = this.durationMs;
		const capMs = this.capMs;
		const factor = this.factor;
		const jitter = this.jitter;

		return new DelayFunc(this.ctx, () => {
			let nextDuration: number;
			[nextDuration, durationMs, steps] = delay(steps, durationMs, capMs, factor, jitter);
			return nextDuration;
		});
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/backoff.go Backoff.Timer.
	timer(): Timer {
		if (this.steps > 1 || this.jitter !== 0) {
			return new VariableTimer(this.delayFunc(), realTimer(this.ctx));
		}
		if (this.durationMs > 0) {
			return new FixedTimer(this.durationMs, realTicker(this.ctx));
		}
		return newNoopTimer();
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/backoff.go Backoff.DelayWithReset.
	delayWithReset(resetIntervalMs: number): DelayFunc {
		if (this.factor <= 0) {
			return this.delayFunc();
		}
		if (resetIntervalMs <= 0) {
			this.steps = 0;
			this.factor = 0;
			return this.delayFunc();
		}
		const manager = new BackoffManager(this.ctx, this, resetIntervalMs);
		return new DelayFunc(this.ctx, manager.step.bind(manager));
	}

	copy(): Backoff {
		return new Backoff(this.ctx, {
			durationMs: this.durationMs,
			factor: this.factor,
			jitter: this.jitter,
			steps: this.steps,
			capMs: this.capMs,
		});
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/util/wait/backoff.go backoffManager.
class BackoffManager {
	private backoff: Backoff;
	private readonly initialBackoff: Backoff;
	private readonly resetIntervalMs: number;
	private readonly clock: Clock;
	private lastStart: Date;

	constructor(ctx: context.Context, backoff: Backoff, resetIntervalMs: number) {
		this.backoff = backoff.copy();
		this.initialBackoff = backoff.copy();
		this.resetIntervalMs = resetIntervalMs;
		const clock = getClock(ctx);
		this.clock = clock;
		this.lastStart = clock.now();
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/backoff.go backoffManager.Step.
	step(): number {
		if (this.resetIntervalMs === 0) {
			this.backoff = this.initialBackoff.copy();
		} else if (this.clock.nowMs() - this.lastStart.getTime() > this.resetIntervalMs) {
			this.backoff = this.initialBackoff.copy();
			this.lastStart = this.clock.now();
		}
		return this.backoff.step();
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/util/wait/backoff.go UntilWithContext.
export async function untilWithContext(
	ctx: context.Context,
	f: FuncWithContext,
	periodMs: number,
): Promise<void> {
	await backoffUntilWithContext(ctx, f, new Backoff(ctx, { durationMs: periodMs }).timer(), true);
}

// Models staging/src/k8s.io/apimachinery/pkg/util/wait/backoff.go BackoffUntilWithContext.
async function backoffUntilWithContext(
	ctx: context.Context,
	f: FuncWithContext,
	timer: Timer,
	sliding: boolean,
): Promise<void> {
	try {
		for (;;) {
			if (ctx.err()) {
				return;
			}

			if (!sliding) {
				timer.next();
			}

			await f(ctx);

			if (sliding) {
				timer.next();
			}

			const selected = await select()
				.case(ctx.done(), () => "done" as const)
				.case(timer.c(), () => "time" as const);
			if (selected === "done") {
				return;
			}
		}
	} finally {
		timer.stop();
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/util/wait/backoff.go delay.
function delay(
	steps: number,
	durationMs: number,
	capMs: number,
	factor: number,
	jitter: number,
): [durationMs: number, next: number, nextSteps: number] {
	if (steps < 1) {
		if (jitter > 0) {
			return [jitterDuration(durationMs, jitter), durationMs, 0];
		}
		return [durationMs, durationMs, 0];
	}
	steps--;

	let next = 0;
	if (factor !== 0) {
		next = durationMs * factor;
		if (capMs > 0 && next > capMs) {
			next = capMs;
			steps = 0;
		}
	} else {
		next = durationMs;
	}

	if (jitter > 0) {
		durationMs = jitterDuration(durationMs, jitter);
	}

	return [durationMs, next, steps];
}
