import { expect, it } from "vitest";

import { SortedMap } from "./collections";
import { browser } from "./test/describe";

browser.describe("SortedMap", () => {
	it("keeps entries sorted by key", () => {
		const map = new SortedMap<number, string>((left, right) => left - right);

		map.set(3, "c");
		map.set(1, "a");
		map.set(2, "b");

		expect(Array.from(map.entries())).toEqual([
			[1, "a"],
			[2, "b"],
			[3, "c"],
		]);
	});

	it("replaces existing values with the same key", () => {
		const map = new SortedMap<string, string>((left, right) => left.localeCompare(right));

		map.set("a", "1");
		const previous = map.set("a", "2");

		expect(previous).toEqual("1");
		expect(Array.from(map.entries())).toEqual([["a", "2"]]);
	});

	it("can iterate from a lower bound and clear earlier keys", () => {
		const map = new SortedMap<number, string>(
			(left, right) => left - right,
			[
				[1, "a"],
				[2, "b"],
				[3, "c"],
				[4, "d"],
			],
		);

		expect(Array.from(map.entriesFrom(3))).toEqual([
			[3, "c"],
			[4, "d"],
		]);
		expect(map.clearBefore(3)).toBe(2);
		expect(Array.from(map.entries())).toEqual([
			[3, "c"],
			[4, "d"],
		]);
	});
});
