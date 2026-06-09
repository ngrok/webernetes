/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import { browser } from "../../../../test/describe";
import { newString } from "./string";

browser.describe("sets string", () => {
	// Models staging/src/k8s.io/apimachinery/pkg/util/sets/string.go NewString.
	it("creates string sets", () => {
		const set = newString("b", "a", "b", "");

		expect(set.len()).toBe(3);
		expect(set.list()).toEqual(["", "a", "b"]);
	});

	// Models staging/src/k8s.io/apimachinery/pkg/util/sets/string.go String.Insert.
	it("inserts strings", () => {
		const set = newString();

		set.insert("b", "a", "b");

		expect(set.len()).toBe(2);
		expect(set.list()).toEqual(["a", "b"]);
	});
});
