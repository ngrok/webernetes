import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Clock, MockedDate } from "./clock";

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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

describe("Clock", () => {
	let clock: Clock;
	beforeEach(() => {
		clock = new Clock();
	});

	afterEach(() => {
		clock.clear();
	});

	it("should get the current time", () => {
		const fakeNow = clock.now();
		const realNow = new Date();
		expect(diffMs(fakeNow, realNow)).toBeLessThan(3);
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
		await wait(20);
		const time2 = clock.now();

		expect(diffMs(time1, time2)).toBe(0);
	});

	it("should drift further from real time as paused time passes", async () => {
		const diffs: number[] = [];

		for (let i = 0; i < 5; i++) {
			clock.pause();
			await wait(10);
			clock.resume();
			await wait(10);
			diffs.push(diffMs(new Date(), clock.now()));
		}

		for (let i = 1; i < diffs.length; i++) {
			const previous = diffs[i - 1];
			const current = diffs[i];
			if (previous === undefined || current === undefined) {
				throw new Error("Expected adjacent diffs");
			}
			expect(current).toBeGreaterThan(previous);
		}
	});

	it("should not complete timeouts when paused", async () => {
		let completed = false;
		clock.setTimeout(() => {
			if (completed) {
				throw new Error("already completed");
			}
		}, 10);
		clock.pause();
		await wait(20);
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
		await wait(20);
		expect(completed).toBe(false);
		clock.resume();
		await vi.waitFor(
			() => {
				expect(completed).toBe(true);
			},
			{ timeout: 100, interval: 5 },
		);
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
		await wait(20);
		clock.resume();
		await vi.waitFor(
			() => {
				expect(realCompletedAt).toBeDefined();
				expect(fakeCompletedAt).toBeDefined();
			},
			{ timeout: 100, interval: 5 },
		);

		if (!realCompletedAt || !fakeCompletedAt) {
			throw new Error("Expected timeout to complete");
		}

		const realElapsedMs = diffMs(realCompletedAt, now);
		expect(realElapsedMs).toBeGreaterThanOrEqual(30);

		const fakeElapsedMs = diffMs(fakeCompletedAt, now);
		expect(fakeElapsedMs).toBeGreaterThanOrEqual(9);
		expect(realElapsedMs - fakeElapsedMs).toBeGreaterThanOrEqual(20);
	});

	it("should be able to cancel a task", async () => {
		let completed = false;
		const timer = clock.setTimeout(() => {
			completed = true;
		}, 10);
		clock.clearTimeout(timer);
		await wait(20);
		expect(completed).toBe(false);
	});

	it("should be able to cancel all tasks", async () => {
		const clock = new Clock();
		let completed = false;
		clock.setTimeout(() => {
			completed = true;
		}, 10);
		clock.clear();
		await wait(20);
		expect(completed).toBe(false);
	});

	it("should flush microtasks asynchronously", async () => {
		const calls: string[] = [];

		clock.queueMicrotask(() => {
			calls.push("microtask");
		});

		calls.push("sync");
		expect(calls).toEqual(["sync"]);

		await vi.waitFor(
			() => {
				expect(calls).toEqual(["sync", "microtask"]);
			},
			{ timeout: 100, interval: 5 },
		);
	});

	it("should flush nested microtasks in order", async () => {
		const calls: string[] = [];

		clock.queueMicrotask(() => {
			calls.push("first");
			clock.queueMicrotask(() => {
				calls.push("second");
			});
		});

		await vi.waitFor(
			() => {
				expect(calls).toEqual(["first", "second"]);
			},
			{ timeout: 100, interval: 5 },
		);
	});

	it("should not flush microtasks while paused", async () => {
		const calls: string[] = [];

		clock.pause();
		clock.queueMicrotask(() => {
			calls.push("microtask");
		});

		await wait(0);
		expect(calls).toEqual([]);

		clock.resume();
		await vi.waitFor(
			() => {
				expect(calls).toEqual(["microtask"]);
			},
			{ timeout: 100, interval: 5 },
		);
	});

	it("should clear queued microtasks", async () => {
		let completed = false;

		clock.pause();
		clock.queueMicrotask(() => {
			completed = true;
		});
		clock.clear();
		clock.resume();

		await wait(0);
		expect(completed).toBe(false);
	});

	it("should correctly handle intervals", async () => {
		const realTimes: Date[] = [new Date()];
		const fakeTimes: Date[] = [clock.now()];
		clock.setInterval(() => {
			realTimes.push(new Date());
			fakeTimes.push(clock.now());
		}, 10);
		await vi.waitFor(
			() => {
				expect(fakeTimes.length).toBeGreaterThanOrEqual(3);
			},
			{ timeout: 100, interval: 5 },
		);

		for (const diff of diffTimes(realTimes)) {
			expect(diff).toBeGreaterThanOrEqual(9);
		}
		for (const diff of diffTimes(fakeTimes)) {
			expect(diff).toBeGreaterThanOrEqual(9);
		}
	});

	it("should correctly handle intervals with pauses", async () => {
		const realTimes: Date[] = [new Date()];
		const fakeTimes: Date[] = [clock.now()];
		clock.setInterval(() => {
			realTimes.push(new Date());
			fakeTimes.push(clock.now());
		}, 10);
		clock.pause();
		await wait(20);
		clock.resume();
		await vi.waitFor(
			() => {
				expect(fakeTimes.length).toBeGreaterThanOrEqual(3);
			},
			{ timeout: 100, interval: 5 },
		);

		const [firstDiff, ...remainingDiffs] = diffTimes(realTimes);
		expect(firstDiff).toBeGreaterThanOrEqual(20);
		for (const diff of remainingDiffs) {
			expect(diff).toBeGreaterThanOrEqual(9);
		}
		for (const diff of diffTimes(fakeTimes)) {
			expect(diff).toBeGreaterThanOrEqual(9);
		}
	});

	it("should dispose correctly", async () => {
		let completed = false;
		{
			using clock = new Clock();
			clock.setTimeout(() => {
				completed = true;
			}, 10);
		}
		await wait(20);
		expect(completed).toBe(false);
	});
});
