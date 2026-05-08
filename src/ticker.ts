import { EventEmitter } from "events";
import type { Clock } from "./clock";

// This Ticker class exists to match the semantics of Go's ticker:
//   https://pkg.go.dev/time#Ticker
//
// Go's ticker sends ticks on a channel. If the receiver is slow, the ticker
// does not run receiver work concurrently. Instead, it keeps at most one tick
// waiting and drops additional ticks until the receiver reads again. That means
// a 50ms ticker with a receiver that takes 60ms effectively delivers a tick
// roughly every 60ms, while the tick timestamps still reveal the underlying
// 50ms schedule and any dropped ticks.
//
// Verification program:
//
//   package main
//
//   import (
//   	"fmt"
//   	"time"
//   )
//
//   func main() {
//   	ticker := time.NewTicker(50 * time.Millisecond)
//   	defer ticker.Stop()
//
//   	start := time.Now()
//   	var prevRecv time.Time
//   	var prevTick time.Time
//   	for i := 0; i < 8; i++ {
//   		tick := <-ticker.C
//   		recv := time.Now()
//   		if i == 0 {
//   			fmt.Printf("%d recv=%4dms tick=%4dms\n",
//   				i, recv.Sub(start).Milliseconds(), tick.Sub(start).Milliseconds())
//   		} else {
//   			fmt.Printf("%d recv=%4dms +%3dms tick=%4dms +%3dms\n",
//   				i,
//   				recv.Sub(start).Milliseconds(),
//   				recv.Sub(prevRecv).Milliseconds(),
//   				tick.Sub(start).Milliseconds(),
//   				tick.Sub(prevTick).Milliseconds())
//   		}
//   		prevRecv = recv
//   		prevTick = tick
//   		time.Sleep(60 * time.Millisecond)
//   	}
//   }
//
// Example output:
//
//   0 recv=  50ms tick=  50ms
//   1 recv= 111ms + 61ms tick=  99ms + 49ms
//   2 recv= 172ms + 61ms tick= 149ms + 50ms
//   3 recv= 233ms + 61ms tick= 199ms + 49ms
//   4 recv= 294ms + 61ms tick= 249ms + 50ms
//   5 recv= 355ms + 61ms tick= 299ms + 50ms
//   6 recv= 416ms + 61ms tick= 400ms +100ms
//   7 recv= 476ms + 60ms tick= 449ms + 49ms
export class Ticker extends EventEmitter {
	private intervalHandle: number | undefined;
	private inTickHandler = false;
	private pendingTick: Date | undefined;

	constructor(
		private readonly clock: Clock,
		private intervalMs: number,
	) {
		super();
		validateInterval(intervalMs);
	}

	start(): void {
		if (this.intervalHandle !== undefined) {
			return;
		}
		this.intervalHandle = this.clock.setInterval(() => {
			this.emitTick();
		}, this.intervalMs);
	}

	public on(eventName: "tick", listener: (now: Date) => void | Promise<void>): this {
		super.on(eventName, listener);
		return this;
	}

	stop(): void {
		if (this.intervalHandle !== undefined) {
			this.clock.clearInterval(this.intervalHandle);
			this.intervalHandle = undefined;
		}
		this.pendingTick = undefined;
	}

	get stopped(): boolean {
		return this.intervalHandle === undefined;
	}

	reset(intervalMs: number): void {
		validateInterval(intervalMs);
		this.stop();
		this.intervalMs = intervalMs;
		this.start();
	}

	tick(): void {
		if (this.intervalHandle === undefined) {
			return;
		}
		this.emitTick();
	}

	private emitTick(): void {
		if (this.inTickHandler) {
			this.pendingTick ??= this.clock.now();
			return;
		}

		this.dispatchTick(this.clock.now());
	}

	private dispatchTick(now: Date): void {
		this.inTickHandler = true;
		const listeners = this.listeners("tick");
		void Promise.allSettled(listeners.map((listener) => listener(now))).finally(() => {
			this.inTickHandler = false;
			if (this.intervalHandle === undefined) {
				this.pendingTick = undefined;
				return;
			}
			const pendingTick = this.pendingTick;
			this.pendingTick = undefined;
			if (pendingTick) {
				this.dispatchTick(pendingTick);
			}
		});
	}
}

function validateInterval(intervalMs: number): void {
	if (intervalMs <= 0) {
		throw new Error("Ticker interval must be greater than 0");
	}
}
