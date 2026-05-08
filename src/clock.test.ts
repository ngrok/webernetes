import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Clock, MockedDate } from "./clock";
import { browser } from "./test/describe";

function diffMs(time1: Date, time2: Date): number {
	return time1.getTime() - time2.getTime();
}

function diffTimes(times: Date[]): number[] {
	const result: number[] = [];
	for (let i = 1; i < times.length; i++) {
		const current = times[i];
		const previous = times[i - 1];
		if (!current || !previous) {
			throw new Error("Expected adjacent timestamps");
		}
		result.push(diffMs(current, previous));
	}
	return result;
}

browser.describe("Clock", () => {
	let clock: Clock;

	beforeEach(() => {
		vi.useFakeTimers();
		clock = new Clock();
	});

	afterEach(() => {
		clock.clear();
		vi.useRealTimers();
	});

	it("should get the current time", () => {
		const fakeNow = clock.now();
		const realNow = new Date();
		expect(diffMs(fakeNow, realNow)).toBe(0);
	});

	it("should give out MockedDates", () => {
		const fakeNow = clock.now();
		expect(fakeNow instanceof MockedDate).toBe(true);
	});

	it("should be pausable", async () => {
		expect(clock.isPaused()).toBe(false);

		clock.pause();
		expect(clock.isPaused()).toBe(true);

		const time1 = clock.now();
		await vi.advanceTimersByTimeAsync(20);
		const time2 = clock.now();

		expect(diffMs(time1, time2)).toBe(0);
	});

	it("should drift further from real time as paused time passes", async () => {
		const diffs: number[] = [];

		for (let i = 0; i < 5; i++) {
			clock.pause();
			await vi.advanceTimersByTimeAsync(10);
			clock.resume();
			await vi.advanceTimersByTimeAsync(10);
			diffs.push(diffMs(new Date(), clock.now()));
		}

		expect(diffs).toEqual([10, 20, 30, 40, 50]);
	});

	it("should not complete timeouts when paused", async () => {
		let completed = false;
		clock.setTimeout(() => {
			if (completed) {
				throw new Error("already completed");
			}
			completed = true;
		}, 10);
		clock.pause();
		await vi.advanceTimersByTimeAsync(20);
		expect(completed).toBe(false);
	});

	it("should complete timeouts when resumed", async () => {
		let completed = false;
		clock.setTimeout(() => {
			if (completed) {
				throw new Error("already completed");
			}
			completed = true;
		}, 10);
		clock.pause();
		await vi.advanceTimersByTimeAsync(20);
		expect(completed).toBe(false);

		clock.resume();
		await vi.advanceTimersByTimeAsync(9);
		expect(completed).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(completed).toBe(true);
	});

	it("should complete resumed timeouts at the correct time", async () => {
		let realCompletedAt: Date | undefined = undefined;
		let fakeCompletedAt: Date | undefined = undefined;
		clock.setTimeout(() => {
			if (realCompletedAt || fakeCompletedAt) {
				throw new Error("already completed");
			}
			realCompletedAt = new Date();
			fakeCompletedAt = clock.now();
		}, 10);
		const now = new Date();

		clock.pause();
		await vi.advanceTimersByTimeAsync(20);
		clock.resume();
		await vi.advanceTimersByTimeAsync(10);

		if (!realCompletedAt || !fakeCompletedAt) {
			throw new Error("Expected timeout to complete");
		}

		const realElapsedMs = diffMs(realCompletedAt, now);
		expect(realElapsedMs).toBe(30);

		const fakeElapsedMs = diffMs(fakeCompletedAt, now);
		expect(fakeElapsedMs).toBe(10);
		expect(realElapsedMs - fakeElapsedMs).toBe(20);
	});

	it("should be able to cancel a task", async () => {
		let completed = false;
		const timer = clock.setTimeout(() => {
			completed = true;
		}, 10);
		clock.clearTimeout(timer);
		await vi.advanceTimersByTimeAsync(20);
		expect(completed).toBe(false);
	});

	it("should be able to cancel all tasks", async () => {
		let completed = false;
		clock.setTimeout(() => {
			completed = true;
		}, 10);
		clock.clear();
		await vi.advanceTimersByTimeAsync(20);
		expect(completed).toBe(false);
	});

	it("should flush microtasks asynchronously", async () => {
		const calls: string[] = [];

		clock.queueMicrotask(() => {
			calls.push("microtask");
		});

		calls.push("sync");
		expect(calls).toEqual(["sync"]);

		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toEqual(["sync", "microtask"]);
	});

	it("should flush nested microtasks in order", async () => {
		const calls: string[] = [];

		clock.queueMicrotask(() => {
			calls.push("first");
			clock.queueMicrotask(() => {
				calls.push("second");
			});
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toEqual(["first", "second"]);
	});

	it("should not flush microtasks while paused", async () => {
		const calls: string[] = [];

		clock.pause();
		clock.queueMicrotask(() => {
			calls.push("microtask");
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toEqual([]);

		clock.resume();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toEqual(["microtask"]);
	});

	it("should clear queued microtasks", async () => {
		let completed = false;

		clock.pause();
		clock.queueMicrotask(() => {
			completed = true;
		});
		clock.clear();
		clock.resume();

		await vi.advanceTimersByTimeAsync(0);
		expect(completed).toBe(false);
	});

	it("should correctly handle intervals", async () => {
		const realTimes: Date[] = [new Date()];
		const fakeTimes: Date[] = [clock.now()];
		clock.setInterval(() => {
			realTimes.push(new Date());
			fakeTimes.push(clock.now());
		}, 10);

		await vi.advanceTimersByTimeAsync(30);

		expect(diffTimes(realTimes)).toEqual([10, 10, 10]);
		expect(diffTimes(fakeTimes)).toEqual([10, 10, 10]);
	});

	it("should correctly handle intervals with pauses", async () => {
		const realTimes: Date[] = [new Date()];
		const fakeTimes: Date[] = [clock.now()];
		clock.setInterval(() => {
			realTimes.push(new Date());
			fakeTimes.push(clock.now());
		}, 10);

		clock.pause();
		await vi.advanceTimersByTimeAsync(20);
		clock.resume();
		await vi.advanceTimersByTimeAsync(30);

		expect(diffTimes(realTimes)).toEqual([30, 10, 10]);
		expect(diffTimes(fakeTimes)).toEqual([10, 10, 10]);
	});

	it("should dispose correctly", async () => {
		let completed = false;
		{
			using clock = new Clock();
			clock.setTimeout(() => {
				completed = true;
			}, 10);
		}
		await vi.advanceTimersByTimeAsync(20);
		expect(completed).toBe(false);
	});
});
