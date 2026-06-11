/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { Channel, type ReadOnlyChannel } from "../../../../go/channel";
import type * as context from "../../../../go/context";
import * as time from "../../../../go/time";
import type { DelayFunc } from "./delay";

export interface ClockTimer {
	C: ReadOnlyChannel<Date>;
	reset(delayMs: number): boolean;
	stop(): boolean;
}

export interface ClockTicker {
	C: ReadOnlyChannel<Date>;
	stop(): void;
}

export type NewTimerFunc = (delayMs: number) => ClockTimer;
export type NewTickerFunc = (intervalMs: number) => ClockTicker;

// Models staging/src/k8s.io/apimachinery/pkg/util/wait/timer.go Timer.
export interface Timer {
	c(): ReadOnlyChannel<Date>;
	next(): void;
	stop(): void;
}

// Models staging/src/k8s.io/apimachinery/pkg/util/wait/timer.go noopTimer.
class NoopTimer implements Timer {
	private readonly closedCh: ReadOnlyChannel<Date>;

	constructor() {
		const channel = new Channel<Date>();
		channel.close();
		this.closedCh = channel.readOnly();
	}

	c(): ReadOnlyChannel<Date> {
		return this.closedCh;
	}

	next(): void {}

	stop(): void {}
}

// Models staging/src/k8s.io/apimachinery/pkg/util/wait/timer.go newNoopTimer.
export function newNoopTimer(): Timer {
	return new NoopTimer();
}

// Models staging/src/k8s.io/apimachinery/pkg/util/wait/timer.go variableTimer.
export class VariableTimer implements Timer {
	private t: ClockTimer | undefined;

	constructor(
		private readonly fn: DelayFunc,
		private readonly newTimer: NewTimerFunc,
	) {}

	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/timer.go variableTimer.C.
	c(): ReadOnlyChannel<Date> {
		if (!this.t) {
			const f = this.fn.next();
			this.t = this.newTimer(f);
		}
		return this.t.C;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/timer.go variableTimer.Next.
	next(): void {
		if (!this.t) {
			return;
		}
		const delayMs = this.fn.next();
		this.t.reset(delayMs);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/timer.go variableTimer.Stop.
	stop(): void {
		if (!this.t) {
			return;
		}
		this.t.stop();
		this.t = undefined;
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/util/wait/timer.go fixedTimer.
export class FixedTimer implements Timer {
	private t: ClockTicker | undefined;

	constructor(
		private readonly intervalMs: number,
		private readonly newTicker: NewTickerFunc,
	) {}

	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/timer.go fixedTimer.C.
	c(): ReadOnlyChannel<Date> {
		if (!this.t) {
			this.t = this.newTicker(this.intervalMs);
		}
		return this.t.C;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/timer.go fixedTimer.Next.
	next(): void {}

	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/timer.go fixedTimer.Stop.
	stop(): void {
		if (!this.t) {
			return;
		}
		this.t.stop();
		this.t = undefined;
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/util/wait/timer.go RealTimer.
export function realTimer(ctx: context.Context): NewTimerFunc {
	return (delayMs) => new time.Timer(ctx, delayMs);
}

export function realTicker(ctx: context.Context): NewTickerFunc {
	return (intervalMs) => new time.Ticker(ctx, intervalMs);
}
