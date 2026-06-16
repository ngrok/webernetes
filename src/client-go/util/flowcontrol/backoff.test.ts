import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Clock } from "../../../clock";
import { browser } from "../../../test/describe";
import { newBackOff } from "./backoff";

browser.describe("flowcontrol backoff", () => {
	let clock: Clock;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-19T00:00:00.000Z"));
		clock = new Clock();
	});

	afterEach(() => {
		clock.clear();
		vi.useRealTimers();
	});

	it("tracks exponential backoff windows", async () => {
		const backoff = newBackOff(10_000, 300_000, clock);
		const id = "pod_image";

		backoff.next(id, clock.now());
		expect(backoff.get(id)).toBe(10_000);
		expect(backoff.isInBackOffSinceUpdate(id, clock.now())).toBe(true);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(backoff.isInBackOffSinceUpdate(id, clock.now())).toBe(false);

		backoff.next(id, clock.now());
		expect(backoff.get(id)).toBe(20_000);

		await vi.advanceTimersByTimeAsync(20_000);
		backoff.next(id, clock.now());
		expect(backoff.get(id)).toBe(40_000);
	});

	it("caps backoff at the max duration", async () => {
		const backoff = newBackOff(10_000, 300_000, clock);
		const id = "pod_image";

		for (let i = 0; i < 8; i++) {
			backoff.next(id, clock.now());
			await vi.advanceTimersByTimeAsync(backoff.get(id));
		}

		expect(backoff.get(id)).toBe(300_000);
	});
});
