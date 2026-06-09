/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import { browser } from "../../../../../test/describe";
import { isLabelKey, isLabelValue } from "./kube";

browser.describe("content kube validation", () => {
	// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/kube_test.go TestIsLabelKey.
	it("TestIsLabelKey", () => {
		const successCases = [
			"simple",
			"now-with-dashes",
			"1-starts-with-num",
			"1234",
			"simple/simple",
			"now-with-dashes/simple",
			"now-with-dashes/now-with-dashes",
			"now.with.dots/simple",
			"now-with.dashes-and.dots/simple",
			"1-num.2-num/3-num",
			"1234/5678",
			"1.2.3.4/5678",
			"Uppercase_Is_OK_123",
			"example.com/Uppercase_Is_OK_123",
			"requests.storage-foo",
			"a".repeat(63),
			`${"a".repeat(253)}/${"b".repeat(63)}`,
		];
		for (let i = 0; i < successCases.length; i++) {
			const errs = isLabelKey(successCases[i] as string);
			expect(errs).toHaveLength(0);
		}

		const errorCases = [
			"nospecialchars%^=@",
			"cantendwithadash-",
			"-cantstartwithadash-",
			"only/one/slash",
			"Example.com/abc",
			"example_com/abc",
			"example.com/",
			"/simple",
			"a".repeat(64),
			`${"a".repeat(254)}/abc`,
		];
		for (let i = 0; i < errorCases.length; i++) {
			const errs = isLabelKey(errorCases[i] as string);
			expect(errs.length).not.toBe(0);
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/kube_test.go TestIsLabelValue.
	it("TestIsLabelValue", () => {
		const successCases = [
			"simple",
			"now-with-dashes",
			"1-starts-with-num",
			"end-with-num-1",
			"1234",
			"a".repeat(63),
			"",
		];
		for (let i = 0; i < successCases.length; i++) {
			const errs = isLabelValue(successCases[i] as string);
			expect(errs).toHaveLength(0);
		}

		const errorCases = [
			"nospecialchars%^=@",
			"Tama-nui-te-rā.is.Māori.sun",
			"\\backslashes\\are\\bad",
			"-starts-with-dash",
			"ends-with-dash-",
			".starts.with.dot",
			"ends.with.dot.",
			"a".repeat(64),
		];
		for (let i = 0; i < errorCases.length; i++) {
			const errs = isLabelValue(errorCases[i] as string);
			expect(errs.length).not.toBe(0);
		}
	});
});
