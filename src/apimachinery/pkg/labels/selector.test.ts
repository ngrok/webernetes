// oxlint-disable jest/no-conditional-expect
import { expect, it } from "vitest";
import { browser } from "../../../test/describe";
import {
	doesNotExist,
	doubleEquals,
	equals,
	exists,
	greaterThan,
	inOperator,
	lessThan,
	notEquals,
	notIn,
} from "../selection/operator";
import {
	binaryOperators,
	closedParToken,
	commaToken,
	doesNotExistToken,
	doubleEqualsToken,
	endOfStringToken,
	everything,
	equalsToken,
	greaterThanToken,
	identifierToken,
	inToken,
	InternalSelector,
	keyAndOperator,
	lessThanToken,
	Lexer,
	matchesNothing,
	newRequirement,
	newSelector,
	notEqualsToken,
	notInToken,
	nothing,
	openParToken,
	parse,
	Parser,
	Requirement,
	safeSort,
	selectorFromSet,
	sharedEverythingSelector,
	sharedNothingSelector,
	type Token,
	ValidatedSetSelector,
	validatedSelectorFromSet,
} from "./selector";
import { Set } from "./labels";
import {
	ErrorList,
	errorTypeInvalid,
	errorTypeNotSupported,
	FieldError,
} from "../util/validation/field/errors";
import type { Aggregate } from "../util/errors/errors";

browser.describe("labels selector", () => {
	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestSelectorParse.
	it("TestSelectorParse", () => {
		const testGoodStrings = [
			"x=a,y=b,z=c",
			"",
			"x!=a,y=b",
			"x=",
			"x= ",
			"x=,z= ",
			"x= ,z= ",
			"!x",
			"x>1",
			"x>1,z<5",
		];
		const testBadStrings = ["x=a||y=b", "x==a==b", "!x=a", "x<a"];
		for (const test of testGoodStrings) {
			const [lq, err] = parse(test);
			expect(err).toBeUndefined();
			expect(lq?.string()).toBe(test.replaceAll(" ", ""));
		}
		for (const test of testBadStrings) {
			const [, err] = parse(test);
			expect(err).toBeDefined();
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestDeterministicParse.
	it("TestDeterministicParse", () => {
		const [s1, err] = parse("x=a,a=x");
		const [s2, err2] = parse("a=x,x=a");
		expect(err).toBeUndefined();
		expect(err2).toBeUndefined();
		expect(s1?.string()).toBe(s2?.string());
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestEverything.
	it("TestEverything", () => {
		expect(everything().matches(new Set({ x: "y" }))).toBe(true);
		expect(everything().empty()).toBe(true);
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestSelectorMatches.
	it("TestSelectorMatches", () => {
		expectMatch("", new Set({ x: "y" }));
		expectMatch("x=y", new Set({ x: "y" }));
		expectMatch("x=y,z=w", new Set({ x: "y", z: "w" }));
		expectMatch("x!=y,z!=w", new Set({ x: "z", z: "a" }));
		expectMatch("notin=in", new Set({ notin: "in" })); // in and notin in exactMatch
		expectMatch("x", new Set({ x: "z" }));
		expectMatch("!x", new Set({ y: "z" }));
		expectMatch("x>1", new Set({ x: "2" }));
		expectMatch("x<1", new Set({ x: "0" }));
		expectNoMatch("x=z", new Set({}));
		expectNoMatch("x=y", new Set({ x: "z" }));
		expectNoMatch("x=y,z=w", new Set({ x: "w", z: "w" }));
		expectNoMatch("x!=y,z!=w", new Set({ x: "z", z: "w" }));
		expectNoMatch("x", new Set({ y: "z" }));
		expectNoMatch("!x", new Set({ x: "z" }));
		expectNoMatch("x>1", new Set({ x: "0" }));
		expectNoMatch("x<1", new Set({ x: "2" }));

		const labelset = new Set({ foo: "bar", baz: "blah" });
		expectMatch("foo=bar", labelset);
		expectMatch("baz=blah", labelset);
		expectMatch("foo=bar,baz=blah", labelset);
		expectNoMatch("foo=blah", labelset);
		expectNoMatch("baz=bar", labelset);
		expectNoMatch("foo=bar,foobar=bar,baz=blah", labelset);
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestSetMatches.
	it("TestSetMatches", () => {
		const labelset = new Set({ foo: "bar", baz: "blah" });
		expectMatchDirect(new Set({}), labelset);
		expectMatchDirect(new Set({ foo: "bar" }), labelset);
		expectMatchDirect(new Set({ baz: "blah" }), labelset);
		expectMatchDirect(new Set({ foo: "bar", baz: "blah" }), labelset);
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestNilMapIsValid.
	it("TestNilMapIsValid", () => {
		const selector = new Set(undefined).asSelector();
		expect(selector).toBeDefined();
		expect(selector.empty()).toBe(true);
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestSetIsEmpty.
	it("TestSetIsEmpty", () => {
		expect(new Set({}).asSelector().empty()).toBe(true);
		expect(newSelector().empty()).toBe(true);
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestLexer.
	it("TestLexer", () => {
		const testcases: Array<{ s: string; t: Token }> = [
			{ s: "", t: endOfStringToken },
			{ s: ",", t: commaToken },
			{ s: "notin", t: notInToken },
			{ s: "in", t: inToken },
			{ s: "=", t: equalsToken },
			{ s: "==", t: doubleEqualsToken },
			{ s: ">", t: greaterThanToken },
			{ s: "<", t: lessThanToken },
			{ s: "!", t: doesNotExistToken },
			{ s: "!=", t: notEqualsToken },
			{ s: "(", t: openParToken },
			{ s: ")", t: closedParToken },
			{ s: "~", t: identifierToken },
			{ s: "||", t: identifierToken },
		];
		for (const v of testcases) {
			const l = new Lexer(v.s);
			const [token, lit] = l.lex();
			expect(token).toBe(v.t);
			if (v.t !== "ErrorToken") {
				expect(lit).toBe(v.s);
			}
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestLexerSequence.
	it("TestLexerSequence", () => {
		const testcases: Array<{ s: string; t: Token[] }> = [
			{
				s: "key in ( value )",
				t: [identifierToken, inToken, openParToken, identifierToken, closedParToken],
			},
			{
				s: "key notin ( value )",
				t: [identifierToken, notInToken, openParToken, identifierToken, closedParToken],
			},
			{
				s: "key in ( value1, value2 )",
				t: [
					identifierToken,
					inToken,
					openParToken,
					identifierToken,
					commaToken,
					identifierToken,
					closedParToken,
				],
			},
			{ s: "key", t: [identifierToken] },
			{ s: "!key", t: [doesNotExistToken, identifierToken] },
			{ s: "()", t: [openParToken, closedParToken] },
			{
				s: "x in (),y",
				t: [identifierToken, inToken, openParToken, closedParToken, commaToken, identifierToken],
			},
			{
				s: "== != (), = notin",
				t: [
					doubleEqualsToken,
					notEqualsToken,
					openParToken,
					closedParToken,
					commaToken,
					equalsToken,
					notInToken,
				],
			},
			{ s: "key>2", t: [identifierToken, greaterThanToken, identifierToken] },
			{ s: "key<1", t: [identifierToken, lessThanToken, identifierToken] },
		];
		for (const v of testcases) {
			const tokens: Token[] = [];
			const l = new Lexer(v.s);
			while (true) {
				const [token] = l.lex();
				if (token === endOfStringToken) {
					break;
				}
				tokens.push(token);
			}
			expect(tokens).toHaveLength(v.t.length);
			for (let i = 0; i < Math.min(tokens.length, v.t.length); i++) {
				expect(tokens[i]).toBe(v.t[i]);
			}
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestParserLookahead.
	it("TestParserLookahead", () => {
		const testcases: Array<{ s: string; t: Token[] }> = [
			{
				s: "key in ( value )",
				t: [
					identifierToken,
					inToken,
					openParToken,
					identifierToken,
					closedParToken,
					endOfStringToken,
				],
			},
			{
				s: "key notin ( value )",
				t: [
					identifierToken,
					notInToken,
					openParToken,
					identifierToken,
					closedParToken,
					endOfStringToken,
				],
			},
			{
				s: "key in ( value1, value2 )",
				t: [
					identifierToken,
					inToken,
					openParToken,
					identifierToken,
					commaToken,
					identifierToken,
					closedParToken,
					endOfStringToken,
				],
			},
			{ s: "key", t: [identifierToken, endOfStringToken] },
			{ s: "!key", t: [doesNotExistToken, identifierToken, endOfStringToken] },
			{ s: "()", t: [openParToken, closedParToken, endOfStringToken] },
			{ s: "", t: [endOfStringToken] },
			{
				s: "x in (),y",
				t: [
					identifierToken,
					inToken,
					openParToken,
					closedParToken,
					commaToken,
					identifierToken,
					endOfStringToken,
				],
			},
			{
				s: "== != (), = notin",
				t: [
					doubleEqualsToken,
					notEqualsToken,
					openParToken,
					closedParToken,
					commaToken,
					equalsToken,
					notInToken,
					endOfStringToken,
				],
			},
			{ s: "key>2", t: [identifierToken, greaterThanToken, identifierToken, endOfStringToken] },
			{ s: "key<1", t: [identifierToken, lessThanToken, identifierToken, endOfStringToken] },
		];
		for (const v of testcases) {
			const p = new Parser(new Lexer(v.s));
			p.scan();
			expect(p.scannedItems).toHaveLength(v.t.length);
			while (true) {
				const [token, lit] = p.lookahead(keyAndOperator);
				const [token2, lit2] = p.consume(keyAndOperator);
				if (token === endOfStringToken) {
					break;
				}
				expect(token).toBe(token2);
				expect(lit).toBe(lit2);
			}
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestParseOperator.
	it("TestParseOperator", () => {
		const testcases: Array<{ token: string; expectedError: Error | undefined }> = [
			{ token: "in", expectedError: undefined },
			{ token: "=", expectedError: undefined },
			{ token: "==", expectedError: undefined },
			{ token: ">", expectedError: undefined },
			{ token: "<", expectedError: undefined },
			{ token: "notin", expectedError: undefined },
			{ token: "!=", expectedError: undefined },
			{
				token: "!",
				expectedError: new Error(
					`found '${doesNotExist}', expected: ${binaryOperators.join(", ")}`,
				),
			},
			{
				token: "exists",
				expectedError: new Error(`found '${exists}', expected: ${binaryOperators.join(", ")}`),
			},
			{
				token: "(",
				expectedError: new Error(`found '(', expected: ${binaryOperators.join(", ")}`),
			},
		];
		for (const testcase of testcases) {
			const p = new Parser(new Lexer(testcase.token));
			p.scan();
			const [, err] = p.parseOperator();
			expect(err?.message).toBe(testcase.expectedError?.message);
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestRequirementConstructor.
	it("TestRequirementConstructor", () => {
		const longValue = "a".repeat(254);
		const requirementConstructorTests = [
			{
				key: "x1",
				op: inOperator,
				vals: [],
				wantErr: new ErrorList(new FieldError(errorTypeInvalid, "values", [])),
			},
			{
				key: "x2",
				op: notIn,
				vals: [],
				wantErr: new ErrorList(new FieldError(errorTypeInvalid, "values", [])),
			},
			{ key: "x3", op: inOperator, vals: ["foo"] },
			{ key: "x4", op: notIn, vals: ["foo"] },
			{
				key: "x5",
				op: equals,
				vals: ["bar", "foo"],
				wantErr: new ErrorList(new FieldError(errorTypeInvalid, "values", ["bar", "foo"])),
			},
			{ key: "x6", op: exists, vals: [] },
			{ key: "x7", op: doesNotExist, vals: [] },
			{
				key: "x8",
				op: exists,
				vals: ["foo"],
				wantErr: new ErrorList(new FieldError(errorTypeInvalid, "values", ["foo"])),
			},
			{ key: "x9", op: inOperator, vals: ["bar"] },
			{ key: "x10", op: inOperator, vals: ["bar"] },
			{ key: "x11", op: greaterThan, vals: ["1"] },
			{ key: "x12", op: lessThan, vals: ["6"] },
			{
				key: "x13",
				op: greaterThan,
				vals: [],
				wantErr: new ErrorList(new FieldError(errorTypeInvalid, "values", [])),
			},
			{
				key: "x14",
				op: greaterThan,
				vals: ["bar"],
				wantErr: new ErrorList(new FieldError(errorTypeInvalid, "values[0]", "bar")),
			},
			{
				key: "x15",
				op: lessThan,
				vals: ["bar"],
				wantErr: new ErrorList(new FieldError(errorTypeInvalid, "values[0]", "bar")),
			},
			{
				key: longValue,
				op: exists,
				vals: [],
				wantErr: new ErrorList(new FieldError(errorTypeInvalid, "key", longValue)),
			},
			{
				key: "x16",
				op: equals,
				vals: [longValue],
				wantErr: new ErrorList(new FieldError(errorTypeInvalid, "values[0][x16]", longValue)),
			},
			{
				key: "x17",
				op: equals,
				vals: ["a b"],
				wantErr: new ErrorList(new FieldError(errorTypeInvalid, "values[0][x17]", "a b")),
			},
			{
				key: "x18",
				op: "unsupportedOp" as typeof inOperator,
				vals: [],
				wantErr: new ErrorList(new FieldError(errorTypeNotSupported, "operator", "unsupportedOp")),
			},
		];
		for (const rc of requirementConstructorTests) {
			const [, err] = newRequirement(rc.key, rc.op, rc.vals);
			expect(fieldAggregateSummary(err)).toEqual(fieldAggregateSummary(rc.wantErr?.toAggregate()));
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestToString.
	it("TestToString", () => {
		const req = new Requirement("", "" as Parameters<typeof newRequirement>[1], []);
		const toStringTests: Array<{ in_: InternalSelector; out: string; valid: boolean }> = [
			{
				in_: new InternalSelector([
					getRequirement("x", inOperator, ["abc", "def"]),
					getRequirement("y", notIn, ["jkl"]),
					getRequirement("z", exists, []),
				]),
				out: "x in (abc,def),y notin (jkl),z",
				valid: true,
			},
			{
				in_: new InternalSelector([
					getRequirement("x", notIn, ["abc", "def"]),
					getRequirement("y", notEquals, ["jkl"]),
					getRequirement("z", doesNotExist, []),
				]),
				out: "x notin (abc,def),y!=jkl,!z",
				valid: true,
			},
			{
				in_: new InternalSelector([getRequirement("x", inOperator, ["abc", "def"]), req]),
				out: "x in (abc,def),",
				valid: false,
			},
			{
				in_: new InternalSelector([
					getRequirement("x", notIn, ["abc"]),
					getRequirement("y", inOperator, ["jkl", "mno"]),
					getRequirement("z", notIn, [""]),
				]),
				out: "x notin (abc),y in (jkl,mno),z notin ()",
				valid: true,
			},
			{
				in_: new InternalSelector([
					getRequirement("x", equals, ["abc"]),
					getRequirement("y", doubleEquals, ["jkl"]),
					getRequirement("z", notEquals, ["a"]),
					getRequirement("z", exists, []),
				]),
				out: "x=abc,y==jkl,z!=a,z",
				valid: true,
			},
			{
				in_: new InternalSelector([
					getRequirement("x", greaterThan, ["2"]),
					getRequirement("y", lessThan, ["8"]),
					getRequirement("z", exists, []),
				]),
				out: "x>2,y<8,z",
				valid: true,
			},
		];
		for (const ts of toStringTests) {
			const out = ts.in_.string();
			if (out === "" && ts.valid) {
				expect.fail(`${ts.in_}.String() => '${out}' expected no error`);
			} else {
				expect(out).toBe(ts.out);
			}
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestRequirementSelectorMatching.
	it("TestRequirementSelectorMatching", () => {
		const req = new Requirement("", equals, []);
		const labelSelectorMatchingTests: Array<{ set: Set; sel: InternalSelector; match: boolean }> = [
			{ set: new Set({ x: "foo", y: "baz" }), sel: new InternalSelector([req]), match: false },
			{
				set: new Set({ x: "foo", y: "baz" }),
				sel: new InternalSelector([
					getRequirement("x", inOperator, ["foo"]),
					getRequirement("y", notIn, ["alpha"]),
				]),
				match: true,
			},
			{
				set: new Set({ x: "foo", y: "baz" }),
				sel: new InternalSelector([
					getRequirement("x", inOperator, ["foo"]),
					getRequirement("y", inOperator, ["alpha"]),
				]),
				match: false,
			},
			{
				set: new Set({ y: "" }),
				sel: new InternalSelector([
					getRequirement("x", notIn, [""]),
					getRequirement("y", exists, []),
				]),
				match: true,
			},
			{
				set: new Set({ y: "" }),
				sel: new InternalSelector([
					getRequirement("x", doesNotExist, []),
					getRequirement("y", exists, []),
				]),
				match: true,
			},
			{
				set: new Set({ y: "" }),
				sel: new InternalSelector([
					getRequirement("x", notIn, [""]),
					getRequirement("y", doesNotExist, []),
				]),
				match: false,
			},
			{
				set: new Set({ y: "baz" }),
				sel: new InternalSelector([getRequirement("x", inOperator, [""])]),
				match: false,
			},
			{
				set: new Set({ z: "2" }),
				sel: new InternalSelector([getRequirement("z", greaterThan, ["1"])]),
				match: true,
			},
			{
				set: new Set({ z: "v2" }),
				sel: new InternalSelector([getRequirement("z", greaterThan, ["1"])]),
				match: false,
			},
		];
		for (const lsm of labelSelectorMatchingTests) {
			expect(lsm.sel.matches(lsm.set)).toBe(lsm.match);
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestSetSelectorParser.
	it("TestSetSelectorParser", () => {
		const setSelectorParserTests: Array<{
			in_: string;
			out?: InternalSelector;
			match: boolean;
			valid: boolean;
		}> = [
			{ in_: "", out: new InternalSelector(), match: true, valid: true },
			{
				in_: "\rx",
				out: new InternalSelector([getRequirement("x", exists, [])]),
				match: true,
				valid: true,
			},
			{
				in_: "this-is-a-dns.domain.com/key-with-dash",
				out: new InternalSelector([
					getRequirement("this-is-a-dns.domain.com/key-with-dash", exists, []),
				]),
				match: true,
				valid: true,
			},
			{
				in_: "this-is-another-dns.domain.com/key-with-dash in (so,what)",
				out: new InternalSelector([
					getRequirement("this-is-another-dns.domain.com/key-with-dash", inOperator, [
						"so",
						"what",
					]),
				]),
				match: true,
				valid: true,
			},
			{
				in_: "0.1.2.domain/99 notin (10.10.100.1, tick.tack.clock)",
				out: new InternalSelector([
					getRequirement("0.1.2.domain/99", notIn, ["10.10.100.1", "tick.tack.clock"]),
				]),
				match: true,
				valid: true,
			},
			{
				in_: "foo  in\t (abc)",
				out: new InternalSelector([getRequirement("foo", inOperator, ["abc"])]),
				match: true,
				valid: true,
			},
			{
				in_: "x notin\n (abc)",
				out: new InternalSelector([getRequirement("x", notIn, ["abc"])]),
				match: true,
				valid: true,
			},
			{
				in_: "x  notin\t\t\t(abc,def)",
				out: new InternalSelector([getRequirement("x", notIn, ["abc", "def"])]),
				match: true,
				valid: true,
			},
			{
				in_: "x in (abc,def)",
				out: new InternalSelector([getRequirement("x", inOperator, ["abc", "def"])]),
				match: true,
				valid: true,
			},
			{
				in_: "x in (abc,)",
				out: new InternalSelector([getRequirement("x", inOperator, ["abc", ""])]),
				match: true,
				valid: true,
			},
			{
				in_: "x in (abc,abc)",
				out: new InternalSelector([getRequirement("x", inOperator, ["abc"])]),
				match: true,
				valid: true,
			},
			{
				in_: "x in ()",
				out: new InternalSelector([getRequirement("x", inOperator, [""])]),
				match: true,
				valid: true,
			},
			{
				in_: "x in (a,,)",
				out: new InternalSelector([getRequirement("x", inOperator, ["a", ""])]),
				match: true,
				valid: true,
			},
			{
				in_: "x in (a,,,)",
				out: new InternalSelector([getRequirement("x", inOperator, ["a", ""])]),
				match: true,
				valid: true,
			},
			{
				in_: "x in (a,,,,,,)",
				out: new InternalSelector([getRequirement("x", inOperator, ["a", ""])]),
				match: true,
				valid: true,
			},
			{
				in_: "x in (a,,a,,a,,a,,)",
				out: new InternalSelector([getRequirement("x", inOperator, ["a", ""])]),
				match: true,
				valid: true,
			},
			{
				in_: "x notin (abc,,def),bar,z in (),w",
				out: new InternalSelector([
					getRequirement("bar", exists, []),
					getRequirement("w", exists, []),
					getRequirement("x", notIn, ["abc", "", "def"]),
					getRequirement("z", inOperator, [""]),
				]),
				match: true,
				valid: true,
			},
			{
				in_: "x,y in (a)",
				out: new InternalSelector([
					getRequirement("y", inOperator, ["a"]),
					getRequirement("x", exists, []),
				]),
				match: false,
				valid: true,
			},
			{
				in_: "x=a",
				out: new InternalSelector([getRequirement("x", equals, ["a"])]),
				match: true,
				valid: true,
			},
			{
				in_: "x>1",
				out: new InternalSelector([getRequirement("x", greaterThan, ["1"])]),
				match: true,
				valid: true,
			},
			{
				in_: "x<7",
				out: new InternalSelector([getRequirement("x", lessThan, ["7"])]),
				match: true,
				valid: true,
			},
			{
				in_: "x=a,y!=b",
				out: new InternalSelector([
					getRequirement("x", equals, ["a"]),
					getRequirement("y", notEquals, ["b"]),
				]),
				match: true,
				valid: true,
			},
			{
				in_: "x=a,y!=b,z in (h,i,j)",
				out: new InternalSelector([
					getRequirement("x", equals, ["a"]),
					getRequirement("y", notEquals, ["b"]),
					getRequirement("z", inOperator, ["h", "i", "j"]),
				]),
				match: true,
				valid: true,
			},
			{ in_: "x=a||y=b", out: new InternalSelector(), match: false, valid: false },
			{ in_: "x,,y", match: true, valid: false },
			{ in_: ",x,y", match: true, valid: false },
			{ in_: "x nott in (y)", match: true, valid: false },
			{
				in_: "x notin ( )",
				out: new InternalSelector([getRequirement("x", notIn, [""])]),
				match: true,
				valid: true,
			},
			{
				in_: "x notin (, a)",
				out: new InternalSelector([getRequirement("x", notIn, ["", "a"])]),
				match: true,
				valid: true,
			},
			{ in_: "a in (xyz),", match: true, valid: false },
			{ in_: "a in (xyz)b notin ()", match: true, valid: false },
			{
				in_: "a ",
				out: new InternalSelector([getRequirement("a", exists, [])]),
				match: true,
				valid: true,
			},
			{
				in_: "a in (x,y,notin, z,in)",
				out: new InternalSelector([
					getRequirement("a", inOperator, ["in", "notin", "x", "y", "z"]),
				]),
				match: true,
				valid: true,
			},
			{ in_: "a in (xyz abc)", match: false, valid: false },
			{ in_: "a notin(", match: true, valid: false },
			{ in_: "a (", match: false, valid: false },
			{ in_: "(", match: false, valid: false },
		];

		for (const ssp of setSelectorParserTests) {
			const [sel, err] = parse(ssp.in_);
			if (err && ssp.valid) {
				expect.fail(`Parse(${ssp.in_}) => ${err.message} expected no error`);
			} else if (!err && !ssp.valid) {
				expect.fail(`Parse(${ssp.in_}) => ${sel} expected error`);
			} else if (ssp.match && sel && ssp.out) {
				expect(sel).toEqual(ssp.out);
			}
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestAdd.
	it("TestAdd", () => {
		const testCases = [
			{
				name: "keyInOperator",
				sel: new InternalSelector(),
				key: "key",
				operator: inOperator,
				values: ["value"],
				refSelector: new InternalSelector([new Requirement("key", inOperator, ["value"])]),
			},
			{
				name: "keyEqualsOperator",
				sel: new InternalSelector([new Requirement("key", inOperator, ["value"])]),
				key: "key2",
				operator: equals,
				values: ["value2"],
				refSelector: new InternalSelector([
					new Requirement("key", inOperator, ["value"]),
					new Requirement("key2", equals, ["value2"]),
				]),
			},
		];
		for (const ts of testCases) {
			const [req, err] = newRequirement(ts.key, ts.operator, ts.values);
			expect(err).toBeUndefined();
			if (!req) {
				throw new Error(
					`newRequirement(${ts.key}, ${ts.operator}, ${ts.values}) failed: ${err?.message}`,
				);
			}
			const sel = ts.sel.add(req);
			expect(sel).toEqual(ts.refSelector);
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestSafeSort.
	it.each([
		{
			name: "nil strings",
			in: undefined as string[] | undefined,
			inCopy: undefined as string[] | undefined,
			want: undefined as string[] | undefined,
		},
		{
			name: "ordered strings",
			in: ["bar", "foo"],
			inCopy: ["bar", "foo"],
			want: ["bar", "foo"],
		},
		{
			name: "unordered strings",
			in: ["foo", "bar"],
			inCopy: ["foo", "bar"],
			want: ["bar", "foo"],
		},
		{
			name: "duplicated strings",
			in: ["foo", "bar", "foo", "bar"],
			inCopy: ["foo", "bar", "foo", "bar"],
			want: ["bar", "bar", "foo", "foo"],
		},
	])("TestSafeSort $name", (tt) => {
		const got = safeSort(tt.in);
		expect(got).toEqual(tt.want);
		expect(tt.in).toEqual(tt.inCopy);
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestSetSelectorString.
	it("TestSetSelectorString", () => {
		const cases: Array<{ set: Set; out: string }> = [
			{
				set: new Set({}),
				out: "",
			},
			{
				set: new Set({ app: "foo" }),
				out: "app=foo",
			},
			{
				set: new Set({ app: "foo", a: "b" }),
				out: "a=b,app=foo",
			},
		];

		for (const tt of cases) {
			const got = new ValidatedSetSelector(tt.set).string();
			expect(got).toBe(tt.out);
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestRequiresExactMatch.
	it("TestRequiresExactMatch", () => {
		const testCases = [
			{
				name: "keyInOperatorExactMatch",
				sel: newSelector().add(getRequirement("key", inOperator, ["value"])),
				label: "key",
				expectedFound: true,
				expectedValue: "value",
			},
			{
				name: "keyInOperatorNotExactMatch",
				sel: newSelector().add(getRequirement("key", inOperator, ["value", "value2"])),
				label: "key",
				expectedFound: false,
				expectedValue: "",
			},
			{
				name: "keyInOperatorNotExactMatch",
				sel: newSelector().add(
					getRequirement("key", inOperator, ["value", "value1"]),
					getRequirement("key2", inOperator, ["value2"]),
				),
				label: "key2",
				expectedFound: true,
				expectedValue: "value2",
			},
			{
				name: "keyEqualOperatorExactMatch",
				sel: newSelector().add(getRequirement("key", equals, ["value"])),
				label: "key",
				expectedFound: true,
				expectedValue: "value",
			},
			{
				name: "keyDoubleEqualOperatorExactMatch",
				sel: newSelector().add(getRequirement("key", doubleEquals, ["value"])),
				label: "key",
				expectedFound: true,
				expectedValue: "value",
			},
			{
				name: "keyNotEqualOperatorExactMatch",
				sel: newSelector().add(getRequirement("key", notEquals, ["value"])),
				label: "key",
				expectedFound: false,
				expectedValue: "",
			},
			{
				name: "keyEqualOperatorExactMatchFirst",
				sel: newSelector().add(
					getRequirement("key", inOperator, ["value"]),
					getRequirement("key2", inOperator, ["value2"]),
				),
				label: "key",
				expectedFound: true,
				expectedValue: "value",
			},
		];
		for (const ts of testCases) {
			const [value, found] = ts.sel.requiresExactMatch(ts.label);
			expect(found).toBe(ts.expectedFound);
			if (found) {
				expect(value).toBe(ts.expectedValue);
			}
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestValidatedSelectorFromSet.
	it("TestValidatedSelectorFromSet", () => {
		const tests: Array<{
			name: string;
			input: Set;
			expectedSelector?: InternalSelector;
			expectedError?: ErrorList;
		}> = [
			{
				name: "Simple Set, no error",
				input: new Set({ key: "val" }),
				expectedSelector: new InternalSelector([new Requirement("key", equals, ["val"])]),
			},
			{
				name: "Invalid Set, value too long",
				input: new Set({
					Key: "axahm2EJ8Phiephe2eixohbee9eGeiyees1thuozi1xoh0GiuH3diewi8iem7Nui",
				}),
				expectedError: new ErrorList(
					new FieldError(
						errorTypeInvalid,
						"values[0][Key]",
						"axahm2EJ8Phiephe2eixohbee9eGeiyees1thuozi1xoh0GiuH3diewi8iem7Nui",
					),
				),
			},
		];

		for (const tc of tests) {
			const [selector, err] = validatedSelectorFromSet(tc.input);
			expect(fieldAggregateSummary(err)).toEqual(
				fieldAggregateSummary(tc.expectedError?.toAggregate()),
			);
			if (!err) {
				expect(selector).toEqual(tc.expectedSelector);
			}
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestRequirementEqual.
	it.each([
		{
			name: "same requirements should be equal",
			x: new Requirement("key", equals, ["foo", "bar"]),
			y: new Requirement("key", equals, ["foo", "bar"]),
			want: true,
		},
		{
			name: "requirements with different keys should not be equal",
			x: new Requirement("key1", equals, ["foo", "bar"]),
			y: new Requirement("key2", equals, ["foo", "bar"]),
			want: false,
		},
		{
			name: "requirements with different operators should not be equal",
			x: new Requirement("key", equals, ["foo", "bar"]),
			y: new Requirement("key", inOperator, ["foo", "bar"]),
			want: false,
		},
		{
			name: "requirements with different values should not be equal",
			x: new Requirement("key", equals, ["foo", "bar"]),
			y: new Requirement("key", equals, ["foobar"]),
			want: false,
		},
	])("TestRequirementEqual $name", (tt) => {
		expect(tt.x.equal(tt.y)).toBe(tt.want);
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go TestMatchesNothing.
	it("TestMatchesNothing", () => {
		const tests: Array<{
			name: string;
			selector?: string;
			set?: Record<string, string>;
			labelSelector?: ReturnType<typeof newSelector>;
			want: boolean;
		}> = [
			{
				name: "MatchNothing should match Nothing()",
				labelSelector: nothing(),
				want: true,
			},
			{
				name: "MatchNothing should match sharedNothingSelector",
				labelSelector: sharedNothingSelector,
				want: true,
			},
			{
				name: "MatchNothing should not match Everything()",
				labelSelector: everything(),
				want: false,
			},
			{
				name: "MatchNothing should not match sharedEverythingSelector",
				labelSelector: sharedEverythingSelector,
				want: false,
			},
			{
				name: "MatchNothing should not match empty set",
				set: {},
				want: false,
			},
			{
				name: "MatchNothing should not match non-empty set",
				set: { key: "value" },
				want: false,
			},
			{ name: "MatchNothing should not match empty selector", selector: "", want: false },
			{
				name: "MatchNothing should not match non-empty selector - exists",
				selector: "a",
				want: false,
			},
			{
				name: "MatchNothing should not match non-empty selector - not exists",
				selector: "!a",
				want: false,
			},
			{
				name: "MatchNothing should not match non-empty selector - equals",
				selector: "a=b",
				want: false,
			},
			{
				name: "MatchNothing should not match non-empty selector - not equals",
				selector: "a!=b",
				want: false,
			},
			{
				name: "MatchNothing should not match non-empty selector - in",
				selector: "a in (b)",
				want: false,
			},
			{
				name: "MatchNothing should not match non-empty selector - notin",
				selector: "a notin (b)",
				want: false,
			},
			{
				name: "MatchNothing should not match non-empty selector - conflict exists and not exists",
				selector: "a,!a",
				want: false,
			},
			{
				name: "MatchNothing should not match non-empty selector - conflict equals and not equals",
				selector: "a=b,a!=b",
				want: false,
			},
			{
				name: "MatchNothing should not match non-empty selector - conflict in and notin",
				selector: "a in (b),a notin (b)",
				want: false,
			},
		];

		for (const test of tests) {
			if (test.labelSelector) {
				expectMatchNothing(test.labelSelector, test.want);
			} else if (test.set) {
				expectMatchNothing(selectorFromSet(new Set(test.set)), test.want);
			} else {
				const [selector, err] = parse(test.selector ?? "");
				expect(err).toBeUndefined();
				if (!selector) {
					throw new Error(`parse(${test.selector}) failed: ${err?.message}`);
				}
				expectMatchNothing(selector, test.want);
			}
		}
	});
});

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go expectMatch.
function expectMatch(selector: string, ls: Set): void {
	const [lq, err] = parse(selector);
	expect(err).toBeUndefined();
	expect(lq?.matches(ls)).toBe(true);
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go expectNoMatch.
function expectNoMatch(selector: string, ls: Set): void {
	const [lq, err] = parse(selector);
	expect(err).toBeUndefined();
	expect(lq?.matches(ls)).toBe(false);
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go expectMatchDirect.
function expectMatchDirect(selector: Set, ls: Set): void {
	expect(selectorFromSet(selector).matches(ls)).toBe(true);
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go getRequirement.
function getRequirement(key: string, op: Parameters<typeof newRequirement>[1], vals: string[]) {
	const setVals = [...new globalThis.Set(vals).keys()].sort();
	const [requirement, err] = newRequirement(key, op, setVals);
	expect(err).toBeUndefined();
	if (!requirement) {
		throw new Error("requirement is undefined");
	}
	return requirement;
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go ignoreDetail.
function fieldAggregateSummary(err: Error | undefined) {
	if (!err) {
		return undefined;
	}
	const aggregate = err as Aggregate;
	return aggregate.errors.map((err) => {
		const fieldErr = err as FieldError;
		return { type: fieldErr.type, field: fieldErr.field, badValue: fieldErr.badValue };
	});
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector_test.go expectMatchNothing.
function expectMatchNothing(selector: ReturnType<typeof newSelector>, want: boolean): void {
	expect(matchesNothing(selector)).toBe(want);
}
