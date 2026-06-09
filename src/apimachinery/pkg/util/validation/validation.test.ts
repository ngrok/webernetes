/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import { browser } from "../../../../test/describe";
import { isDNS1123Label, isDNS1123Subdomain, isValidLabelValue } from "./validation";

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/validation_test.go TestIsDNS1123Label.
browser.describe("isDNS1123Label", () => {
	const goodValues = [
		"a",
		"ab",
		"abc",
		"a1",
		"a-1",
		"a--1--2--b",
		"0",
		"01",
		"012",
		"1a",
		"1-a",
		"1--a--b--2",
		"a".repeat(63),
	];

	for (const value of goodValues) {
		it(`accepts ${value}`, () => {
			expect(isDNS1123Label(value)).toHaveLength(0);
		});
	}

	const badValues = [
		"",
		"A",
		"ABC",
		"aBc",
		"A1",
		"A-1",
		"1-A",
		"-",
		"a-",
		"-a",
		"1-",
		"-1",
		"_",
		"a_",
		"_a",
		"a_b",
		"1_",
		"_1",
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
		"a".repeat(64),
	];

	for (const value of badValues) {
		it(`rejects ${value}`, () => {
			expect(isDNS1123Label(value).length).toBeGreaterThan(0);
		});
	}
});

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/validation_test.go TestIsDNS1123Subdomain.
browser.describe("isDNS1123Subdomain", () => {
	const goodValues = [
		"a",
		"ab",
		"abc",
		"a1",
		"a-1",
		"a--1--2--b",
		"0",
		"01",
		"012",
		"1a",
		"1-a",
		"1--a--b--2",
		"a.a",
		"ab.a",
		"abc.a",
		"a1.a",
		"a-1.a",
		"a--1--2--b.a",
		"a.1",
		"ab.1",
		"abc.1",
		"a1.1",
		"a-1.1",
		"a--1--2--b.1",
		"0.a",
		"01.a",
		"012.a",
		"1a.a",
		"1-a.a",
		"1--a--b--2",
		"0.1",
		"01.1",
		"012.1",
		"1a.1",
		"1-a.1",
		"1--a--b--2.1",
		"a.b.c.d.e",
		"aa.bb.cc.dd.ee",
		"1.2.3.4.5",
		"11.22.33.44.55",
		"a".repeat(253),
	];

	for (const value of goodValues) {
		it(`accepts ${value}`, () => {
			expect(isDNS1123Subdomain(value)).toHaveLength(0);
		});
	}

	const badValues = [
		"",
		"A",
		"ABC",
		"aBc",
		"A1",
		"A-1",
		"1-A",
		"-",
		"a-",
		"-a",
		"1-",
		"-1",
		"_",
		"a_",
		"_a",
		"a_b",
		"1_",
		"_1",
		"1_2",
		".",
		"a.",
		".a",
		"a..b",
		"1.",
		".1",
		"1..2",
		" ",
		"a ",
		" a",
		"a b",
		"1 ",
		" 1",
		"1 2",
		"A.a",
		"aB.a",
		"ab.A",
		"A1.a",
		"a1.A",
		"A.1",
		"aB.1",
		"A1.1",
		"1A.1",
		"0.A",
		"01.A",
		"012.A",
		"1A.a",
		"1a.A",
		"A.B.C.D.E",
		"AA.BB.CC.DD.EE",
		"a.B.c.d.e",
		"aa.bB.cc.dd.ee",
		"a@b",
		"a,b",
		"a_b",
		"a;b",
		"a:b",
		"a%b",
		"a?b",
		"a$b",
		"a".repeat(254),
	];

	for (const value of badValues) {
		it(`rejects ${value}`, () => {
			expect(isDNS1123Subdomain(value).length).toBeGreaterThan(0);
		});
	}
});

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/validation_test.go TestIsValidLabelValue.
browser.describe("isValidLabelValue", () => {
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
		const value = successCases[i] as string;
		it(`accepts ${value}`, () => {
			expect(isValidLabelValue(value)).toHaveLength(0);
		});
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
		const value = errorCases[i] as string;
		it(`rejects ${value}`, () => {
			expect(isValidLabelValue(value).length).toBeGreaterThan(0);
		});
	}
});
