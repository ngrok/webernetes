import { expect, it } from "vitest";

import * as fnv from "./fnv";
import { browser } from "./test/describe";

browser.describe("fnv", () => {
	it("computes FNV-1a 32-bit hashes", () => {
		const hash = fnv.new32a();
		hash.write("hello");
		expect(hash.sum32()).toBe(0x4f9f2cab);
	});
});
