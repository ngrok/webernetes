import { Channel, type ReadOnlyChannel } from "./channel";
import type { Clock } from "../clock";
import { getClock } from "../clock-context";
import type { Context } from "./context";

// after waits for the duration to elapse and then sends the current time on the
// returned channel, matching Go's time.After:
//   https://pkg.go.dev/time#After
export function after(ctx: Context, delayMs: number): ReadOnlyChannel<Date> {
	const clock = getClock(ctx);
	const channel = new Channel<Date>(1);
	clock.setTimeout(() => {
		channel.trySend(clock.now());
	}, delayMs);
	return channel.readOnly();
}

// tick is a convenience wrapper for Ticker, matching Go's time.Tick:
//   https://pkg.go.dev/time#Tick
//
// Intentional divergence: Go returns nil when d <= 0. This helper throws
// instead so TypeScript callers do not need to null-check every tick channel.
export function tick(ctx: Context, intervalMs: number): ReadOnlyChannel<Date> {
	return new Ticker(ctx, intervalMs).C;
}

// Timer models Go's time.Timer:
//   https://pkg.go.dev/time#Timer
export class Timer {
	private readonly ticks = new Channel<Date>(1, (result) => {
		if (result.ok) {
			this.pendingTick = false;
		}
	});
	private timeoutHandle: number | undefined;
	private active = false;
	private pendingTick = false;

	readonly C: ReadOnlyChannel<Date> = this.ticks.readOnly();
	private readonly clock: Clock;

	constructor(ctx: Context, delayMs: number) {
		this.clock = getClock(ctx);
		this.reset(delayMs);
	}

	stop(): boolean {
		const pending = this.active || this.pendingTick;
		if (this.timeoutHandle !== undefined) {
			this.clock.clearTimeout(this.timeoutHandle);
			this.timeoutHandle = undefined;
		}
		this.active = false;
		this.pendingTick = false;
		this.ticks.drainBuffered();
		return pending;
	}

	get stopped(): boolean {
		return !this.active && !this.pendingTick;
	}

	reset(delayMs: number): boolean {
		const pending = this.stop();
		this.active = true;
		this.timeoutHandle = this.clock.setTimeout(() => {
			this.timeoutHandle = undefined;
			this.active = false;
			this.pendingTick = true;
			this.ticks.trySend(this.clock.now());
		}, delayMs);
		return pending;
	}
}

// This Ticker class exists to match the semantics of Go's ticker:
//   https://pkg.go.dev/time#Ticker
//
// Go's ticker sends ticks on a channel. If the receiver is slow, the ticker
// keeps at most one tick waiting and drops additional ticks until the receiver
// reads again. The tick timestamps still reveal the underlying schedule and any
// dropped ticks.
export class Ticker {
	private readonly ticks = new Channel<Date>(1);
	private intervalHandle: number | undefined;
	private readonly clock: Clock;

	readonly C: ReadOnlyChannel<Date> = this.ticks.readOnly();

	constructor(ctx: Context, intervalMs: number) {
		this.clock = getClock(ctx);
		this.start(intervalMs);
	}

	private start(intervalMs: number): void {
		validateInterval(intervalMs);
		this.stop();
		this.intervalHandle = this.clock.setInterval(() => {
			this.ticks.trySend(this.clock.now());
		}, intervalMs);
	}

	stop(): void {
		if (this.intervalHandle === undefined) {
			return;
		}
		this.clock.clearInterval(this.intervalHandle);
		this.intervalHandle = undefined;
		this.ticks.drainBuffered();
	}

	get stopped(): boolean {
		return this.intervalHandle === undefined;
	}

	reset(intervalMs: number): void {
		this.start(intervalMs);
	}
}

function validateInterval(intervalMs: number): void {
	if (intervalMs <= 0) {
		throw new Error("Ticker interval must be greater than 0");
	}
}
