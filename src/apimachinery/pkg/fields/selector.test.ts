import { expect, it } from "vitest";

import { browser } from "../../../test/describe";
import { Set } from "./fields";
import {
	AndTerm,
	escapeValue,
	HasTerm,
	InvalidEscapeSequence,
	NotHasTerm,
	parseAndTransformSelector,
	parseSelector,
	selectorFromSet,
	splitTerm,
	splitTerms,
	unescapeValue,
} from "./selector";
import { everything, oneTermEqualSelector } from "./selector";

browser.describe("fields selector", () => {
	// Models staging/src/k8s.io/apimachinery/pkg/fields/selector_test.go TestSplitTerms.
	it("splits terms", () => {
		const testCases: Record<string, string[] | undefined> = {
			a: ["a"],
			"a=avalue": ["a=avalue"],
			"a=avalue,b=bvalue": ["a=avalue", "b=bvalue"],
			"a=avalue,b==bvalue,c!=cvalue": ["a=avalue", "b==bvalue", "c!=cvalue"],
			"": undefined,
			"a=a,": ["a=a", ""],
			",a=a": ["", "a=a"],
			"k=\\,,k2=v2": ["k=\\,", "k2=v2"],
			"k=\\\\,k2=v2": ["k=\\\\", "k2=v2"],
			"k=\\\\\\,,k2=v2": ["k=\\\\\\,", "k2=v2"],
			"k=\\a\\b\\": ["k=\\a\\b\\"],
			"k=\\": ["k=\\"],
			"함=수,목=록": ["함=수", "목=록"],
		};

		for (const [selector, expectedTerms] of Object.entries(testCases)) {
			expect(splitTerms(selector)).toEqual(expectedTerms);
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/fields/selector_test.go TestSplitTerm.
	it("splits one term", () => {
		const testCases: Record<string, { lhs: string; op: string; rhs: string; ok: boolean }> = {
			"a=value": { lhs: "a", op: "=", rhs: "value", ok: true },
			"b==value": { lhs: "b", op: "==", rhs: "value", ok: true },
			"c!=value": { lhs: "c", op: "!=", rhs: "value", ok: true },
			"": { lhs: "", op: "", rhs: "", ok: false },
			a: { lhs: "", op: "", rhs: "", ok: false },
			"k=\\,": { lhs: "k", op: "=", rhs: "\\,", ok: true },
			"k=\\=": { lhs: "k", op: "=", rhs: "\\=", ok: true },
			"k=\\\\\\a\\b\\=\\,\\": { lhs: "k", op: "=", rhs: "\\\\\\a\\b\\=\\,\\", ok: true },
			"함=수": { lhs: "함", op: "=", rhs: "수", ok: true },
		};

		for (const [term, expected] of Object.entries(testCases)) {
			const [lhs, op, rhs, ok] = splitTerm(term);
			expect({ lhs, op, rhs, ok }).toEqual(expected);
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/fields/selector_test.go TestEscapeValue.
	it("escapes and unescapes values", () => {
		const testCases: Record<string, string> = {
			"": "",
			a: "a",
			"=": "\\=",
			",": "\\,",
			"\\": "\\\\",
			"\\=\\,\\": "\\\\\\=\\\\\\,\\\\",
		};

		for (const [unescapedValue, escapedValue] of Object.entries(testCases)) {
			expect(escapeValue(unescapedValue)).toBe(escapedValue);
			const [actualUnescaped, err] = unescapeValue(escapedValue);
			expect(err).toBeUndefined();
			expect(actualUnescaped).toBe(unescapedValue);
		}

		for (const invalidValue of ["\\", "\\\\\\", "\\a"]) {
			const [, err] = unescapeValue(invalidValue);
			expect(err).toBeInstanceOf(InvalidEscapeSequence);
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/fields/selector_test.go TestSelectorParse.
	it("parses selectors", () => {
		const testGoodStrings = ["x=a,y=b,z=c", "", "x!=a,y=b", "x=a||y\\=b", "x=a\\=\\=b"];
		const testBadStrings = ["x=a||y=b", "x==a==b", "x=a,b", "x in (a)", "x in (a,b,c)", "x"];

		for (const test of testGoodStrings) {
			const [lq, err] = parseSelector(test);
			expect(err).toBeUndefined();
			expect(lq?.string()).toBe(test);
		}
		for (const test of testBadStrings) {
			const [, err] = parseSelector(test);
			expect(err).toBeDefined();
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/fields/selector_test.go TestDeterministicParse.
	it("parses deterministically", () => {
		const [s1, err] = parseSelector("x=a,a=x");
		const [s2, err2] = parseSelector("a=x,x=a");
		expect(err).toBeUndefined();
		expect(err2).toBeUndefined();
		expect(s1?.string()).toBe(s2?.string());
	});

	// Models staging/src/k8s.io/apimachinery/pkg/fields/selector_test.go TestEverything.
	it("matches everything", () => {
		expect(everything().matches(new Set({ x: "y" }))).toBe(true);
		expect(everything().empty()).toBe(true);
	});

	// Models staging/src/k8s.io/apimachinery/pkg/fields/selector_test.go TestSelectorMatches.
	it("matches parsed selectors", () => {
		expectMatch("", new Set({ x: "y" }));
		expectMatch("x=y", new Set({ x: "y" }));
		expectMatch("x=y,z=w", new Set({ x: "y", z: "w" }));
		expectMatch("x!=y,z!=w", new Set({ x: "z", z: "a" }));
		expectMatch("notin=in", new Set({ notin: "in" }));
		expectNoMatch("x=y", new Set({ x: "z" }));
		expectNoMatch("x=y,z=w", new Set({ x: "w", z: "w" }));
		expectNoMatch("x!=y,z!=w", new Set({ x: "z", z: "w" }));

		const fieldSet = new Set({
			foo: "bar",
			baz: "blah",
			complex: "=value\\,\\",
		});
		expectMatch("foo=bar", fieldSet);
		expectMatch("baz=blah", fieldSet);
		expectMatch("foo=bar,baz=blah", fieldSet);
		expectMatch("foo=bar,baz=blah,complex=\\=value\\\\\\,\\\\", fieldSet);
		expectNoMatch("foo=blah", fieldSet);
		expectNoMatch("baz=bar", fieldSet);
		expectNoMatch("foo=bar,foobar=bar,baz=blah", fieldSet);
	});

	// Models staging/src/k8s.io/apimachinery/pkg/fields/selector_test.go TestOneTermEqualSelector.
	it("matches one equal term", () => {
		expect(oneTermEqualSelector("x", "y").matches(new Set({ x: "y" }))).toBe(true);
		expect(oneTermEqualSelector("x", "y").matches(new Set({ x: "z" }))).toBe(false);
	});

	// Models staging/src/k8s.io/apimachinery/pkg/fields/selector_test.go TestSetMatches.
	it("matches selectors from sets", () => {
		const labelSet = new Set({
			foo: "bar",
			baz: "blah",
		});
		expectMatchDirect(new Set({}), labelSet);
		expectMatchDirect(new Set({ foo: "bar" }), labelSet);
		expectMatchDirect(new Set({ baz: "blah" }), labelSet);
		expectMatchDirect(new Set({ foo: "bar", baz: "blah" }), labelSet);
		expectNoMatchDirect(new Set({ foo: "=blah" }), labelSet);
		expectNoMatchDirect(new Set({ baz: "=bar" }), labelSet);
		expectNoMatchDirect(new Set({ foo: "=bar", foobar: "bar", baz: "blah" }), labelSet);
	});

	// Models staging/src/k8s.io/apimachinery/pkg/fields/selector_test.go TestNilMapIsValid.
	it("treats nil maps as valid", () => {
		const selector = new Set(undefined).asSelector();
		expect(selector).toBeDefined();
		expect(selector.empty()).toBe(true);
	});

	// Models staging/src/k8s.io/apimachinery/pkg/fields/selector_test.go TestSetIsEmpty.
	it("reports empty sets", () => {
		expect(new Set({}).asSelector().empty()).toBe(true);
		expect(new AndTerm().empty()).toBe(true);
		expect(new HasTerm("", "").empty()).toBe(false);
		expect(new NotHasTerm("", "").empty()).toBe(false);
		expect(new AndTerm([new AndTerm([])]).empty()).toBe(true);
		expect(new AndTerm([new HasTerm("a", "b")]).empty()).toBe(false);
	});

	// Models staging/src/k8s.io/apimachinery/pkg/fields/selector_test.go TestRequiresExactMatch.
	it("reports required exact matches", () => {
		const testCases: Record<
			string,
			{ selector: ReturnType<typeof everything>; label: string; value: string; found: boolean }
		> = {
			"empty set": { selector: new Set({}).asSelector(), label: "test", value: "", found: false },
			"empty hasTerm": { selector: new HasTerm("", ""), label: "test", value: "", found: false },
			"skipped hasTerm": {
				selector: new HasTerm("a", "b"),
				label: "test",
				value: "",
				found: false,
			},
			"valid hasTerm": {
				selector: new HasTerm("test", "b"),
				label: "test",
				value: "b",
				found: true,
			},
			"valid hasTerm no value": {
				selector: new HasTerm("test", ""),
				label: "test",
				value: "",
				found: true,
			},
			"valid notHasTerm": {
				selector: new NotHasTerm("test", "b"),
				label: "test",
				value: "",
				found: false,
			},
			"valid notHasTerm no value": {
				selector: new NotHasTerm("test", ""),
				label: "test",
				value: "",
				found: false,
			},
			"nil andTerm": { selector: new AndTerm(), label: "test", value: "", found: false },
			"empty andTerm": { selector: new AndTerm([]), label: "test", value: "", found: false },
			"nested andTerm": {
				selector: new AndTerm([new AndTerm([])]),
				label: "test",
				value: "",
				found: false,
			},
			"nested andTerm matches": {
				selector: new AndTerm([new HasTerm("test", "b")]),
				label: "test",
				value: "b",
				found: true,
			},
			"andTerm with non-match": {
				selector: new AndTerm([new HasTerm("", ""), new HasTerm("test", "b")]),
				label: "test",
				value: "b",
				found: true,
			},
		};

		for (const [_name, testCase] of Object.entries(testCases)) {
			const [value, found] = testCase.selector.requiresExactMatch(testCase.label);
			expect(value).toBe(testCase.value);
			expect(found).toBe(testCase.found);
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/fields/selector_test.go TestTransform.
	it("transforms selectors", () => {
		const testCases = [
			{
				name: "empty selector",
				selector: "",
				transform: (field: string, value: string) => [field, value, undefined] as const,
				result: "",
				isEmpty: true,
			},
			{
				name: "no-op transform",
				selector: "a=b,c=d",
				transform: (field: string, value: string) => [field, value, undefined] as const,
				result: "a=b,c=d",
				isEmpty: false,
			},
			{
				name: "transform one field",
				selector: "a=b,c=d",
				transform: (field: string, value: string) => {
					if (field === "a") {
						return ["e", "f", undefined] as const;
					}
					return [field, value, undefined] as const;
				},
				result: "e=f,c=d",
				isEmpty: false,
			},
			{
				name: "remove field to make empty",
				selector: "a=b",
				transform: () => ["", "", undefined] as const,
				result: "",
				isEmpty: true,
			},
			{
				name: "remove only one field",
				selector: "a=b,c=d,e=f",
				transform: (field: string, value: string) => {
					if (field === "c") {
						return ["", "", undefined] as const;
					}
					return [field, value, undefined] as const;
				},
				result: "a=b,e=f",
				isEmpty: false,
			},
		];

		for (const [_i, testCase] of testCases.entries()) {
			const [result, err] = parseAndTransformSelector(testCase.selector, testCase.transform);
			expect(err).toBeUndefined();
			expect(result?.empty()).toBe(testCase.isEmpty);
			expect(result?.string()).toBe(testCase.result);
		}
	});
});

function expectMatch(selector: string, ls: Set): void {
	const [lq, err] = parseSelector(selector);
	expect(err).toBeUndefined();
	expect(lq?.matches(ls)).toBe(true);
}

function expectNoMatch(selector: string, ls: Set): void {
	const [lq, err] = parseSelector(selector);
	expect(err).toBeUndefined();
	expect(lq?.matches(ls)).toBe(false);
}

function expectMatchDirect(selector: Set, ls: Set): void {
	expect(selectorFromSet(selector).matches(ls)).toBe(true);
}

function expectNoMatchDirect(selector: Set, ls: Set): void {
	expect(selectorFromSet(selector).matches(ls)).toBe(false);
}
