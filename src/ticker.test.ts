import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Clock } from "./clock";
import { Ticker } from "./ticker";
import { browser } from "./test/describe";

browser.describe("Ticker", () => {
	let clock: Clock;

	beforeEach(() => {
		vi.useFakeTimers();
		clock = new Clock();
	});

	afterEach(() => {
		clock.clear();
		vi.useRealTimers();
	});

	it("emits ticks at a consistent interval", async () => {
		const ticker = new Ticker(clock, 10);
		const times: Date[] = [];
		ticker.on("tick", (now) => {
			times.push(now);
		});

		ticker.start();
		await vi.advanceTimersByTimeAsync(30);

		const firstTick = times[0];
		if (!firstTick) {
			throw new Error("Expected first tick");
		}
		expect(times.map((time) => time.getTime() - firstTick.getTime())).toEqual([0, 10, 20]);
		expect(deltas(times)).toEqual([10, 10]);
	});

	it("does not emit ticks before start or after stop", async () => {
		const ticker = new Ticker(clock, 10);
		let ticks = 0;
		ticker.on("tick", () => {
			ticks++;
		});

		await vi.advanceTimersByTimeAsync(20);
		expect(ticks).toBe(0);
		expect(ticker.stopped).toBe(true);

		ticker.start();
		expect(ticker.stopped).toBe(false);
		await vi.advanceTimersByTimeAsync(10);
		expect(ticks).toBe(1);

		ticker.stop();
		await vi.advanceTimersByTimeAsync(30);
		expect(ticks).toBe(1);
		expect(ticker.stopped).toBe(true);
	});

	it("resets the tick interval", async () => {
		const ticker = new Ticker(clock, 50);
		const times: Date[] = [];
		ticker.on("tick", (now) => {
			times.push(now);
		});

		ticker.start();
		await vi.advanceTimersByTimeAsync(20);
		expect(times).toEqual([]);

		const resetAtMs = clock.nowMs();
		ticker.reset(10);
		await vi.advanceTimersByTimeAsync(9);
		expect(times).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(10);

		expect(times.map((time) => time.getTime() - resetAtMs)).toEqual([10, 20]);
	});

	it("keeps one pending tick while a tick handler is still running", async () => {
		const ticker = new Ticker(clock, 10);
		const startedAt: Date[] = [];
		let unblockFirstTick: () => void = () => {};
		const firstTickStarted = new Promise<void>((resolve) => {
			ticker.on("tick", async (now) => {
				startedAt.push(now);
				if (startedAt.length === 1) {
					resolve();
					await new Promise<void>((unblock) => {
						unblockFirstTick = unblock;
					});
				}
			});
		});
		const secondTickStarted = new Promise<void>((resolve) => {
			ticker.on("tick", () => {
				if (startedAt.length === 2) {
					resolve();
				}
			});
		});

		ticker.start();
		await vi.advanceTimersByTimeAsync(10);
		await firstTickStarted;

		await vi.advanceTimersByTimeAsync(30);
		expect(startedAt.length).toBe(1);

		unblockFirstTick();
		await secondTickStarted;

		const firstTick = startedAt[0];
		const pendingTick = startedAt[1];
		if (!firstTick || !pendingTick) {
			throw new Error("Expected initial and pending ticks");
		}
		expect(pendingTick.getTime() - firstTick.getTime()).toBe(10);
		expect(startedAt.length).toBe(2);
	});

	it("preserves scheduled tick times while a slow handler observes pending ticks", async () => {
		const ticker = new Ticker(clock, 50);
		const startedAt: Date[] = [];
		const startMs = clock.nowMs();
		ticker.on("tick", async (now) => {
			startedAt.push(now);
			await clock.wait(61);
		});

		ticker.start();
		await vi.advanceTimersByTimeAsync(500);
		ticker.stop();

		expect(startedAt.slice(0, 8).map((time) => time.getTime() - startMs)).toEqual([
			50, 100, 150, 200, 250, 300, 400, 450,
		]);
		expect(deltas(startedAt.slice(0, 8))).toEqual([50, 50, 50, 50, 50, 100, 50]);
	});

	it("rejects non-positive intervals", () => {
		expect(() => new Ticker(clock, 0)).toThrow("Ticker interval must be greater than 0");

		const ticker = new Ticker(clock, 10);
		expect(() => ticker.reset(0)).toThrow("Ticker interval must be greater than 0");
	});
});

function deltas(times: Date[]): number[] {
	const result: number[] = [];
	for (let index = 1; index < times.length; index++) {
		const previous = times[index - 1];
		const current = times[index];
		if (!previous || !current) {
			throw new Error("Expected adjacent tick times");
		}
		result.push(current.getTime() - previous.getTime());
	}
	return result;
}
