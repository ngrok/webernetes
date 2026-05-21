import { expect, it } from "vitest";

import { SortedMap, KeyFnMap } from "./collections";
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

browser.describe("KeyFnMap", () => {
	it("uses stable JSON stringification by default", () => {
		const map = new KeyFnMap<{ left: string; right: { b: number; a: number } }, string>();

		map.set({ left: "value", right: { b: 2, a: 1 } }, "matched");

		expect(map.get({ right: { a: 1, b: 2 }, left: "value" })).toBe("matched");
		expect(map.has({ right: { b: 2, a: 1 }, left: "value" })).toBe(true);
	});

	it("compares object keys by the derived string value", () => {
		const map = new KeyFnMap<{ type: string; id: string }, string>(
			(key) => `${key.type}://${key.id}`,
		);

		map.set({ type: "simulator", id: "container-1" }, "running");

		expect(map.has({ type: "simulator", id: "container-1" })).toBe(true);
		expect(map.get({ type: "simulator", id: "container-1" })).toBe("running");
		expect(map.get({ type: "simulator", id: "container-2" })).toBeUndefined();
	});

	it("stores copied keys for iteration so later mutation does not affect entries", () => {
		const map = new KeyFnMap<{ namespace: string; name: string }, number>(
			(key) => `${key.namespace}/${key.name}`,
		);
		const key = { namespace: "default", name: "pod-a" };

		map.set(key, 1);
		key.name = "pod-b";

		expect(map.get({ namespace: "default", name: "pod-a" })).toBe(1);
		expect(Array.from(map.keys())).toEqual([{ namespace: "default", name: "pod-a" }]);
		expect(Array.from(map.entries())).toEqual([[{ namespace: "default", name: "pod-a" }, 1]]);
	});

	it("copies keys before yielding them from iterators", () => {
		const map = new KeyFnMap<{ namespace: string; name: string }, number>(
			(key) => `${key.namespace}/${key.name}`,
		);

		map.set({ namespace: "default", name: "pod-a" }, 1);

		const keyFromEntries = Array.from(map.entries())[0]?.[0];
		if (keyFromEntries) {
			keyFromEntries.name = "mutated";
		}
		const keyFromIterator = Array.from(map)[0]?.[0];
		if (keyFromIterator) {
			keyFromIterator.namespace = "mutated";
		}

		expect(Array.from(map.keys())).toEqual([{ namespace: "default", name: "pod-a" }]);
		expect(map.get({ namespace: "default", name: "pod-a" })).toBe(1);
	});

	it("handles different object key shapes", () => {
		const probeMap = new KeyFnMap<
			{ podUid: string; containerName: string; probeType: string },
			string
		>((key) => `${key.podUid}:${key.containerName}:${key.probeType}`);
		const coordinateMap = new KeyFnMap<{ x: number; y: number }, string>(
			(key) => `${key.x},${key.y}`,
		);

		probeMap.set({ podUid: "pod-1", containerName: "main", probeType: "liveness" }, "ok");
		coordinateMap.set({ x: 1, y: 2 }, "occupied");

		expect(probeMap.get({ podUid: "pod-1", containerName: "main", probeType: "liveness" })).toBe(
			"ok",
		);
		expect(coordinateMap.get({ x: 1, y: 2 })).toBe("occupied");
		expect(Array.from(probeMap.values())).toEqual(["ok"]);
		expect(coordinateMap.delete({ x: 1, y: 2 })).toBe(true);
		expect(coordinateMap.size).toBe(0);
	});
});
