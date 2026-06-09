/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import { browser } from "../../../test/describe";
import { Set, type Fields } from "./fields";

browser.describe("fields", () => {
	// Models staging/src/k8s.io/apimachinery/pkg/fields/fields_test.go TestSetString.
	it("formats sets", () => {
		expect.hasAssertions();
		matches(new Set({ x: "y" }), "x=y");
		matches(new Set({ foo: "bar" }), "foo=bar");
		matches(new Set({ foo: "bar", baz: "qup" }), "baz=qup,foo=bar");
	});

	// Models staging/src/k8s.io/apimachinery/pkg/fields/fields_test.go TestFieldHas.
	it("reports field presence", () => {
		const fieldHasTests: Array<{ ls: Fields; key: string; has: boolean }> = [
			{ ls: new Set({ x: "y" }), key: "x", has: true },
			{ ls: new Set({ x: "" }), key: "x", has: true },
			{ ls: new Set({ x: "y" }), key: "foo", has: false },
		];
		for (const lh of fieldHasTests) {
			expect(lh.ls.has(lh.key)).toBe(lh.has);
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/fields/fields_test.go TestFieldGet.
	it("gets fields", () => {
		const ls = new Set({ x: "y" });
		expect(ls.get("x")).toBe("y");
	});
});

function matches(ls: Set, want: string): void {
	expect(ls.string()).toBe(want);
}
