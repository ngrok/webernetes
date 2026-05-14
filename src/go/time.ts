import { Channel, type ReadOnlyChannel } from "./channel";
import type { Clock } from "../clock";

// after waits for the duration to elapse and then sends the current time on the
// returned channel, matching Go's time.After:
//   https://pkg.go.dev/time#After
export function after(clock: Clock, delayMs: number): ReadOnlyChannel<Date> {
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
export function tick(clock: Clock, intervalMs: number): ReadOnlyChannel<Date> {
	if (intervalMs <= 0) {
		throw new Error("tick interval must be greater than 0");
	}
	return new Ticker(clock, intervalMs).C;
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

	readonly C: ReadOnlyChannel<Date> = this.ticks.readOnly();

	constructor(
		private readonly clock: Clock,
		private intervalMs: number,
	) {
		validateInterval(intervalMs);
		this.intervalHandle = this.clock.setInterval(() => {
			this.emitTick();
		}, this.intervalMs);
	}

	stop(): void {
		if (this.intervalHandle !== undefined) {
			this.clock.clearInterval(this.intervalHandle);
			this.intervalHandle = undefined;
		}
		this.ticks.drainBuffered();
	}

	get stopped(): boolean {
		return this.intervalHandle === undefined;
	}

	reset(intervalMs: number): void {
		validateInterval(intervalMs);
		this.stop();
		this.intervalMs = intervalMs;
		this.intervalHandle = this.clock.setInterval(() => {
			this.emitTick();
		}, this.intervalMs);
	}

	private emitTick(): void {
		this.ticks.trySend(this.clock.now());
	}
}

function validateInterval(intervalMs: number): void {
	if (intervalMs <= 0) {
		throw new Error("Ticker interval must be greater than 0");
	}
}
