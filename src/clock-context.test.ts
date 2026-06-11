import { expect, it } from "vitest";

import { Clock } from "./clock";
import { getClock, withClock } from "./clock-context";
import * as context from "./go/context";
import { browser } from "./test/describe";

browser.describe("Clock context", () => {
	it("stores and retrieves a clock through context", () => {
		const clock = new Clock();
		const ctx = withClock(context.background(), clock);

		expect(getClock(ctx)).toBe(clock);

		clock.clear();
	});

	it("throws when context has no clock", () => {
		expect(() => getClock(context.background())).toThrow("context has no clock");
	});
});
