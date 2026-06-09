/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import { browser } from "../../../../../test/describe";
import { isCIdentifier } from "./identifier";

browser.describe("content identifier validation", () => {
	// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/identifier_test.go TestIsCIdentifier.
	it("validates C identifiers", () => {
		const goodValues = [
			"a",
			"ab",
			"abc",
			"a1",
			"_a",
			"a_",
			"a_b",
			"a_1",
			"a__1__2__b",
			"__abc_123",
			"A",
			"AB",
			"AbC",
			"A1",
			"_A",
			"A_",
			"A_B",
			"A_1",
			"A__1__2__B",
			"__123_ABC",
		];
		for (const val of goodValues) {
			const msgs = isCIdentifier(val);
			expect(msgs).toHaveLength(0);
		}

		const badValues = [
			"",
			"1",
			"123",
			"1a",
			"-",
			"a-",
			"-a",
			"1-",
			"-1",
			"1_",
			"1_2",
			".",
			"a.",
			".a",
			"a.b",
			"1.",
			".1",
			"1.2",
			" ",
			"a ",
			" a",
			"a b",
			"1 ",
			" 1",
			"1 2",
			"#a#",
		];
		for (const val of badValues) {
			const msgs = isCIdentifier(val);
			expect(msgs.length).not.toBe(0);
		}
	});
});
