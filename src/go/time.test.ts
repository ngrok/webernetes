import { afterEach, beforeEach, expect, it } from "vitest";

import { Channel, type ReceiveChannel, select } from "./channel";
import { Clock } from "../clock";
import * as time from "./time";
import { browser } from "../test/describe";

// These tests mirror the Go ticker tests from src/time/tick_test.go at:
// https://github.com/golang/go/blob/58efaf3859e6a6f9988e69afc59c0792888ca41a/src/time/tick_test.go
//
// For TestChan, we only mirror Go's synctimerchan behavior. That is the
// asynctimerchan=0 path and the default Go 1.23+ behavior: timer/ticker channels
// should not expose stale values after Stop or Reset. We do not mirror the old
// async timer channel modes that need drainAsync.
//
// Not mirrored:
// - TestTicker's Darwin/ARM64 timing adjustment and 1s fallback case: these
//   exist to deflake Go's wall-clock runtime tests and would add several
//   seconds without adding new ticker semantics here.
// - TestTickerStopWithDirectInitialization and TestManualTicker: Go permits
//   manual struct initialization of time.Ticker; our Ticker state is private.
// - TestLongAdjustTimers, TestTimerGC, and the benchmarks: these test Go
//   runtime scheduling, garbage collection, or benchmark behavior.
// - TestAfterTimes: Go's version verifies the runtime timer heap with many
//   wall-clock timers. The after tests below cover the observable channel
//   behavior using the simulator Clock instead.
// - TestChan's Timer cases, tickerTimer bool return values, len/cap checks,
//   async-timer drain paths, and GODEBUG matrix.
browser.describe("after", () => {
	let clock: Clock;

	beforeEach(() => {
		clock = new Clock();
	});

	afterEach(() => {
		clock.clear();
	});

	// Go check:
	//
	//   package main
	//
	//   import (
	//   	"fmt"
	//   	"time"
	//   )
	//
	//   func main() {
	//   	start := time.Now()
	//   	after := time.After(10 * time.Millisecond)
	//   	select {
	//   	case <-after:
	//   		fmt.Println("ready before delay")
	//   	default:
	//   		fmt.Println("not ready before delay")
	//   	}
	//   	tick := <-after
	//   	fmt.Println(!tick.Before(start.Add(10 * time.Millisecond)))
	//   }
	//
	// Output:
	//   not ready before delay
	//   true
	it("sends the current time after the delay elapses", async () => {
		const start = clock.nowMs();
		const ch = time.after(clock, 10);

		await expect(maybeReceive(ch)).resolves.toBeUndefined();

		await clock.wait(10);
		const tick = await maybeReceive(ch);

		expect(tick).toBeDefined();
		expect(tick?.getTime()).toBeGreaterThanOrEqual(start + 10);
	});

	// Go check:
	//
	//   package main
	//
	//   import (
	//   	"fmt"
	//   	"time"
	//   )
	//
	//   func main() {
	//   	after := time.After(1 * time.Millisecond)
	//   	<-after
	//   	select {
	//   	case <-after:
	//   		fmt.Println("second value")
	//   	default:
	//   		fmt.Println("no second value")
	//   	}
	//   }
	//
	// Output:
	//   no second value
	it("sends only one value", async () => {
		const ch = time.after(clock, 1);

		await clock.wait(1);
		await expect(ch.receive()).resolves.toMatchObject({ ok: true });
		await expect(maybeReceive(ch)).resolves.toBeUndefined();
	});
});

browser.describe("tick", () => {
	let clock: Clock;

	beforeEach(() => {
		clock = new Clock();
	});

	afterEach(() => {
		clock.clear();
	});

	// Go check:
	//
	//   package main
	//
	//   import (
	//   	"fmt"
	//   	"time"
	//   )
	//
	//   func main() {
	//   	start := time.Now()
	//   	tick := time.Tick(10 * time.Millisecond)
	//   	first := <-tick
	//   	second := <-tick
	//   	fmt.Println(!first.Before(start.Add(10 * time.Millisecond)))
	//   	fmt.Println(second.After(first))
	//   }
	//
	// Output:
	//   true
	//   true
	it("sends ticks on the returned channel", async () => {
		const start = clock.nowMs();
		const ch = time.tick(clock, 10);

		await clock.wait(10);
		const first = await ch.receive();
		await clock.wait(10);
		const second = await ch.receive();

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(first.value?.getTime()).toBeGreaterThanOrEqual(start + 10);
		expect(second.value?.getTime()).toBeGreaterThan(first.value?.getTime() ?? 0);
	});

	// Intentional divergence from Go:
	//
	//   package main
	//
	//   import (
	//   	"fmt"
	//   	"time"
	//   )
	//
	//   func main() {
	//   	fmt.Println(time.Tick(0) == nil)
	//   	fmt.Println(time.Tick(-1) == nil)
	//   }
	//
	// Output:
	//   true
	//   true
	//
	// TypeScript callers get an exception instead of a nullable channel so they
	// do not need to null-check every tick channel.
	it("throws for non-positive intervals", () => {
		expect(() => time.tick(clock, 0)).toThrow("tick interval must be greater than 0");
		expect(() => time.tick(clock, -1)).toThrow("tick interval must be greater than 0");
	});
});

browser.describe("Ticker", () => {
	let clock: Clock;

	beforeEach(() => {
		clock = new Clock();
	});

	afterEach(() => {
		clock.clear();
	});

	// Mirrors Go TestTicker, lines 15-100:
	// https://github.com/golang/go/blob/58efaf3859e6a6f9988e69afc59c0792888ca41a/src/time/tick_test.go#L15-L100
	it("ticks, resets to a new interval, and stops", async () => {
		const baseCount = 10;
		const baseDelta = 20;

		const errs: string[] = [];

		for (const test of [{ count: baseCount, delta: baseDelta }]) {
			const { count, delta } = test;
			const ticker = new time.Ticker(clock, delta);
			const t0 = clock.nowMs();
			for (let range = 0; range < count / 2; range++) {
				const { ok } = await ticker.C.receive();
				expect(ok).toBe(true);
			}
			ticker.reset(delta * 2);
			for (let range = 0; range < count - count / 2; range++) {
				const { ok } = await ticker.C.receive();
				expect(ok).toBe(true);
			}
			ticker.stop();
			const t1 = clock.nowMs();
			const dt = t1 - t0;
			const target = 3 * delta * (count / 2);
			const slop = (target * 3) / 10;
			if (dt < target - slop || dt > target + slop) {
				errs.push(
					`${count / 2} ${delta}ms ticks then ${count / 2} ${delta * 2}ms ticks took ${dt}ms, expected [${target - slop}ms,${target + slop}ms]`,
				);
				continue;
			}

			await clock.wait(2 * delta);
			if (await hasTick(ticker)) {
				errs.push("Ticker did not shut down");
				continue;
			}
		}

		expect(errs).toEqual([]);
	});

	// Mirrors Go TestTicker's dropped-tick timing behavior, lines 56-70:
	// https://github.com/golang/go/blob/58efaf3859e6a6f9988e69afc59c0792888ca41a/src/time/tick_test.go#L56-L70
	it("drops ticks while one unread tick is already pending", async () => {
		const ticker = new time.Ticker(clock, 20);
		const t0 = clock.nowMs();

		await clock.wait(30);
		const first = await ticker.C.receive();
		await clock.wait(100);
		const second = await ticker.C.receive();
		ticker.stop();

		if (!first.value || !second.value) {
			throw new Error("tick missing");
		}

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(first.value.getTime() - t0).toBeGreaterThanOrEqual(20);
		expect(second.value.getTime()).toBeGreaterThan(first.value.getTime());
		expect(second.value.getTime() - first.value.getTime()).toBeLessThan(60);
	});

	// Mirrors Go testTimerChan's simple Stop/Reset ticker checks, lines 460-505:
	// https://github.com/golang/go/blob/58efaf3859e6a6f9988e69afc59c0792888ca41a/src/time/tick_test.go#L460-L505
	it("stops and resets without stale ticks", async () => {
		const sched = 10;
		const tim = new time.Ticker(clock, 10000);

		tim.stop();
		await expect(hasTick(tim)).resolves.toBe(false);

		tim.reset(10000);
		await expect(hasTick(tim)).resolves.toBe(false);

		tim.reset(1);
		await assertTick(tim, clock);

		await clock.wait(sched);
		tim.reset(10000);
		await expect(hasTick(tim)).resolves.toBe(false);

		tim.stop();
	});

	// Mirrors Go TestTeardown, lines 109-122:
	// https://github.com/golang/go/blob/58efaf3859e6a6f9988e69afc59c0792888ca41a/src/time/tick_test.go#L109-L122
	it("can be repeatedly created, ticked, and stopped", async () => {
		const delta = 20;
		for (let range = 0; range < 3; range++) {
			const ticker = new time.Ticker(clock, delta);
			const { ok } = await ticker.C.receive();
			expect(ok).toBe(true);
			ticker.stop();
		}
	});

	// Mirrors Go TestNewTickerLtZeroDuration, lines 132-140:
	// https://github.com/golang/go/blob/58efaf3859e6a6f9988e69afc59c0792888ca41a/src/time/tick_test.go#L132-L140
	it("rejects non-positive new ticker intervals", () => {
		expect(() => new time.Ticker(clock, -1)).toThrow("Ticker interval must be greater than 0");
	});

	// Mirrors Go TestTickerResetLtZeroDuration, lines 142-151:
	// https://github.com/golang/go/blob/58efaf3859e6a6f9988e69afc59c0792888ca41a/src/time/tick_test.go#L142-L151
	it("rejects non-positive reset intervals", () => {
		const tk = new time.Ticker(clock, 1000);
		try {
			expect(() => tk.reset(0)).toThrow("Ticker interval must be greater than 0");
			expect(() => tk.reset(-1)).toThrow("Ticker interval must be greater than 0");
		} finally {
			tk.stop();
		}
	});

	// Mirrors Go TestChan ticker stale-value checks, lines 629-637:
	// https://github.com/golang/go/blob/58efaf3859e6a6f9988e69afc59c0792888ca41a/src/time/tick_test.go#L629-L637
	it("does not receive an old tick after stop", async () => {
		const tim = new time.Ticker(clock, 10000);

		tim.reset(1);
		await clock.wait(10);
		tim.stop();

		await expect(hasTick(tim)).resolves.toBe(false);
	});

	// Mirrors Go TestChan ticker stale-value checks, lines 639-655:
	// https://github.com/golang/go/blob/58efaf3859e6a6f9988e69afc59c0792888ca41a/src/time/tick_test.go#L639-L655
	it("does not receive an old tick after reset", async () => {
		const tim = new time.Ticker(clock, 1000);

		tim.reset(1000);
		await expect(hasTick(tim)).resolves.toBe(false);
		tim.reset(1);
		await assertTick(tim, clock);
		await clock.wait(10);
		await assertTick(tim, clock);
		await clock.wait(10);
		tim.reset(1000);
		await expect(hasTick(tim)).resolves.toBe(false);
		tim.stop();
	});

	// Mirrors Go testTimerChan's blocked receiver reset checks, lines 529-562:
	// https://github.com/golang/go/blob/58efaf3859e6a6f9988e69afc59c0792888ca41a/src/time/tick_test.go#L529-L562
	it("does not wake a blocked receiver until reset is imminent", async () => {
		const sched = 10;
		const tim = new time.Ticker(clock, 10000);
		tim.reset(10000);
		await expect(hasTick(tim)).resolves.toBe(false);

		let done = false;
		void (async () => {
			await tim.C.receive();
			done = true;
		})();
		await clock.wait(sched);
		expect(done).toBe(false);

		tim.reset(20000);
		await clock.wait(sched);
		expect(done).toBe(false);

		tim.reset(1);
		await waitUntil(clock, () => done);

		await assertTick(tim, clock);

		tim.stop();
		await expect(hasTick(tim)).resolves.toBe(false);
	});

	// Mirrors Go testTimerChan's two select receiver checks, lines 564-609:
	// https://github.com/golang/go/blob/58efaf3859e6a6f9988e69afc59c0792888ca41a/src/time/tick_test.go#L564-L609
	it("wakes one of multiple select receivers after reset", async () => {
		const sched = 10;
		const tim = new time.Ticker(clock, 10000);
		tim.reset(10000);
		await expect(hasTick(tim)).resolves.toBe(false);

		const done = new Channel<boolean>(2);
		let done1 = false;
		let done2 = false;
		const stop = new Channel<boolean>();
		void (async () => {
			await select()
				.case(tim.C, () => {
					done.trySend(true);
				})
				.case(stop, () => undefined);
			done1 = true;
		})();
		void (async () => {
			await select()
				.case(tim.C, () => {
					done.trySend(true);
				})
				.case(stop, () => undefined);
			done2 = true;
		})();
		await clock.wait(sched);
		await notDone(done);

		tim.reset(sched / 2);
		await clock.wait(sched);
		await waitDone(done, clock);

		tim.stop();
		stop.close();
		await waitUntil(clock, () => done1);
		await waitUntil(clock, () => done2);

		await maybeReceive(done);
		await maybeTick(tim);
		await notDone(done);
	});

	// Mirrors Go testTimerChan's stopped select receiver checks, lines 611-627:
	// https://github.com/golang/go/blob/58efaf3859e6a6f9988e69afc59c0792888ca41a/src/time/tick_test.go#L611-L627
	it("does not wake select receivers when stopped", async () => {
		const sched = 10;
		const tim = new time.Ticker(clock, 10000);
		tim.stop();
		const stop = new Channel<boolean>();
		const done = new Channel<boolean>(2);

		for (let range = 0; range < 2; range++) {
			void (async () => {
				await select()
					.case(tim.C, () => {
						throw new Error("unexpected data");
					})
					.case(stop, () => undefined);
				expect(done.trySend(true)).toBe(true);
			})();
		}

		await clock.wait(sched);
		stop.close();
		await waitDone(done, clock);
		await waitDone(done, clock);
	});

	// Mirrors Go TestTickTimes, lines 688-702:
	// https://github.com/golang/go/blob/58efaf3859e6a6f9988e69afc59c0792888ca41a/src/time/tick_test.go#L688-L702
	it("reports the scheduled tick time even when read later", async () => {
		for (let range = 0; range < 10; range++) {
			const start = clock.nowMs();
			const c = new time.Ticker(clock, 10);
			await clock.wait(500);
			const tick = await assertTick(c, clock);
			c.stop();
			const dt = tick.getTime() - start;
			if (dt < 400) {
				return;
			}
		}
		throw new Error("not working");
	});
});

async function assertTick(tim: time.Ticker, clock: Clock): Promise<Date> {
	const tick = await maybeTick(tim);
	if (tick) {
		return tick;
	}

	for (let range = 0; range < 100; range++) {
		await clock.wait(10);
		const tick = await maybeTick(tim);
		if (tick) {
			return tick;
		}
	}

	throw new Error("missing tick");
}

async function hasTick(tim: time.Ticker): Promise<boolean> {
	return (await maybeTick(tim)) !== undefined;
}

async function maybeTick(tim: time.Ticker): Promise<Date | undefined> {
	return await select()
		.case(tim.C, ({ value }) => value)
		.default(() => undefined);
}

async function notDone(done: Channel<boolean>): Promise<void> {
	expect(await maybeReceive(done)).toBeUndefined();
}

async function waitDone(done: Channel<boolean>, clock: Clock): Promise<void> {
	if ((await maybeReceive(done)) !== undefined) {
		return;
	}

	for (let range = 0; range < 100; range++) {
		await clock.wait(10);
		if ((await maybeReceive(done)) !== undefined) {
			return;
		}
	}

	throw new Error("never got done");
}

async function maybeReceive<T>(channel: ReceiveChannel<T>): Promise<T | undefined> {
	return await select()
		.case(channel, ({ value }) => value)
		.default(() => undefined);
}

async function waitUntil(clock: Clock, condition: () => boolean): Promise<void> {
	for (let range = 0; range < 100; range++) {
		if (condition()) {
			return;
		}
		await clock.wait(10);
	}

	throw new Error("condition was not met");
}
