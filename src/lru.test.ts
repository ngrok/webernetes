import { expect, it } from "vitest";
import { browser } from "./test/describe";
import { newLRU, newLRUWithEvictionFunc } from "./lru";

interface SimpleStruct {
	int: number;
	string: string;
}

interface ComplexStruct {
	int: number;
	simpleStruct: SimpleStruct;
}

browser.describe("lru", () => {
	// Models k8s.io/utils/lru/lru_test.go TestGet.
	it.each([
		["string_hit", "myKey", "myKey", true],
		["string_miss", "myKey", "nonsense", false],
		["simple_struct_hit", { int: 1, string: "two" }, { int: 1, string: "two" }, true],
		["simple_struct_miss", { int: 1, string: "two" }, { int: 0, string: "noway" }, false],
		[
			"complex_struct_hit",
			{ int: 1, simpleStruct: { int: 2, string: "three" } },
			{ int: 1, simpleStruct: { int: 2, string: "three" } },
			true,
		],
	] as const)("gets %s", (_name, keyToAdd, keyToGet, expectedOk) => {
		const lru = newLRU<string | SimpleStruct | ComplexStruct, number>(0);
		lru.add(keyToAdd, 1234);

		const [value, ok] = lru.get(keyToGet);

		expect(ok).toBe(expectedOk);
		expect(value).toBe(expectedOk ? 1234 : undefined);
	});

	// Models k8s.io/utils/lru/lru_test.go TestRemove.
	it("removes entries", () => {
		const lru = newLRU<string, number>(0);
		lru.add("myKey", 1234);

		expect(lru.get("myKey")).toEqual([1234, true]);

		lru.remove("myKey");

		expect(lru.get("myKey")).toEqual([undefined, false]);
	});

	// Models k8s.io/utils/lru/lru_test.go TestEviction.
	it("calls the eviction function with the evicted entry", () => {
		let seenKey: number | undefined;
		let seenValue: number | undefined;
		const lru = newLRUWithEvictionFunc<number, number>(1, (key, value) => {
			seenKey = key;
			seenValue = value;
		});

		lru.add(1, 2);
		lru.add(3, 4);

		expect(seenKey).toBe(1);
		expect(seenValue).toBe(2);
	});

	// Models k8s.io/utils/lru/lru_test.go TestSetEviction.
	it("sets the eviction function once", () => {
		let seenKey: number | undefined;
		let seenValue: number | undefined;
		const lru = newLRU<number, number>(1);

		const err = lru.setEvictionFunc((key, value) => {
			seenKey = key;
			seenValue = value;
		});

		expect(err).toBeUndefined();
		lru.add(1, 2);
		lru.add(3, 4);
		expect(seenKey).toBe(1);
		expect(seenValue).toBe(2);

		expect(lru.setEvictionFunc(() => {})).toBeInstanceOf(Error);
	});

	it("updates recency on get and add", () => {
		const lru = newLRU<string, number>(2);
		lru.add("a", 1);
		lru.add("b", 2);
		expect(lru.get("a")).toEqual([1, true]);

		lru.add("c", 3);

		expect(lru.get("b")).toEqual([undefined, false]);
		expect(lru.get("a")).toEqual([1, true]);
		expect(lru.get("c")).toEqual([3, true]);

		lru.add("a", 4);
		lru.add("d", 5);

		expect(lru.get("c")).toEqual([undefined, false]);
		expect(lru.get("a")).toEqual([4, true]);
		expect(lru.get("d")).toEqual([5, true]);
	});

	it("removes the oldest entry and clears all entries", () => {
		const evicted: Array<[string, number]> = [];
		const lru = newLRUWithEvictionFunc<string, number>(0, (key, value) => {
			evicted.push([key, value]);
		});
		lru.add("a", 1);
		lru.add("b", 2);
		lru.add("c", 3);

		lru.removeOldest();

		expect(lru.len()).toBe(2);
		expect(lru.get("a")).toEqual([undefined, false]);
		expect(evicted).toEqual([["a", 1]]);

		lru.clear();

		expect(lru.len()).toBe(0);
		expect(evicted).toEqual([
			["a", 1],
			["b", 2],
			["c", 3],
		]);
	});
});
