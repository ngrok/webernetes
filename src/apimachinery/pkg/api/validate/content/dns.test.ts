/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import { browser } from "../../../../../test/describe";
import { isDNS1123Label, isDNS1123Subdomain, isDNS1123SubdomainCaseless } from "./dns";

browser.describe("content DNS validation", () => {
	// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns_test.go TestIsDNS1123Label.
	it("TestIsDNS1123Label", () => {
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
		for (const val of goodValues) {
			const msgs = isDNS1123Label(val);
			expect(msgs).toHaveLength(0);
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
		for (const val of badValues) {
			const msgs = isDNS1123Label(val);
			expect(msgs.length).not.toBe(0);
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns_test.go TestIsDNS1123Subdomain.
	it("TestIsDNS1123Subdomain", () => {
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
		for (const val of goodValues) {
			const msgs = isDNS1123Subdomain(val);
			expect(msgs).toHaveLength(0);
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
		for (const val of badValues) {
			const msgs = isDNS1123Subdomain(val);
			expect(msgs.length).not.toBe(0);
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns_test.go TestIsDNS1123SubdomainCaseless.
	it("TestIsDNS1123SubdomainCaseless", () => {
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
			"A",
			"AB",
			"ABC",
			"A1",
			"A-1",
			"A.A",
			"AB.A",
			"ABC.A",
			"A1.A",
			"A-1.A",
			"A.B.C.D.E",
			"AA.BB.CC.DD.EE",
			"a.B.c.d.e",
			"aa.bB.cc.dd.ee",
			"a".repeat(253),
			"A".repeat(253),
		];
		for (const val of goodValues) {
			const msgs = isDNS1123SubdomainCaseless(val);
			expect(msgs).toHaveLength(0);
		}

		const badValues = [
			"",
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
		for (const val of badValues) {
			const msgs = isDNS1123SubdomainCaseless(val);
			expect(msgs.length).not.toBe(0);
		}
	});
});
