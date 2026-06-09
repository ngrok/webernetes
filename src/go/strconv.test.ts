/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import { browser } from "../test/describe";
import { appendQuote, errRange, errSyntax, NumError, parseInt, parseUint, quote } from "./strconv";

function numErr(fn: string, num: string, err: Error): NumError {
	return new NumError(fn, num, err);
}

const parseUint64Tests = [
	{ in: "", out: 0n, err: numErr("ParseUint", "", errSyntax) },
	{ in: "0", out: 0n },
	{ in: "1", out: 1n },
	{ in: "12345", out: 12345n },
	{ in: "012345", out: 12345n },
	{
		in: "18446744073709551616",
		out: (1n << 64n) - 1n,
		err: numErr("ParseUint", "18446744073709551616", errRange),
	},
	{ in: "-1", out: 0n, err: numErr("ParseUint", "-1", errSyntax) },
];

const parseUint64BaseTests = [
	{ in: "", base: 0, out: 0n, err: numErr("ParseUint", "", errSyntax) },
	{ in: "0", base: 0, out: 0n },
	{ in: "1", base: 0, out: 1n },
	{ in: "-1", base: 0, out: 0n, err: numErr("ParseUint", "-1", errSyntax) },
	{ in: "12345", base: 0, out: 12345n },
	{ in: "012345", base: 0, out: 0o12345n },
	{
		in: "18446744073709551616",
		base: 0,
		out: (1n << 64n) - 1n,
		err: numErr("ParseUint", "18446744073709551616", errRange),
	},
	{ in: "0b", base: 0, out: 0n, err: numErr("ParseUint", "0b", errSyntax) },
	{ in: "101", base: 2, out: 5n },
	{ in: "101_", base: 2, out: 0n, err: numErr("ParseUint", "101_", errSyntax) },
];

const parseInt64Tests = [
	{ in: "", out: 0n, err: numErr("ParseInt", "", errSyntax) },
	{ in: "0", out: 0n },
	{ in: "1", out: 1n },
	{ in: "-1", out: -1n },
	{ in: "12345", out: 12345n },
	{
		in: "9223372036854775808",
		out: (1n << 63n) - 1n,
		err: numErr("ParseInt", "9223372036854775808", errRange),
	},
	{ in: "123%45", out: 0n, err: numErr("ParseInt", "123%45", errSyntax) },
];

const parseInt64BaseTests = [
	{ in: "", base: 0, out: 0n, err: numErr("ParseInt", "", errSyntax) },
	{ in: "0", base: 0, out: 0n },
	{ in: "1", base: 0, out: 1n },
	{ in: "-1", base: 0, out: -1n },
	{ in: "12345", base: 0, out: 12345n },
	{ in: "12345", base: 9, out: 8303n },
	{ in: "012345", base: 0, out: 0o12345n },
	{
		in: "9223372036854775808",
		base: 10,
		out: (1n << 63n) - 1n,
		err: numErr("ParseInt", "9223372036854775808", errRange),
	},
	{ in: "0b", base: 0, out: 0n, err: numErr("ParseInt", "0b", errSyntax) },
	{ in: "101", base: 2, out: 5n },
	{ in: "101_", base: 2, out: 0n, err: numErr("ParseInt", "101_", errSyntax) },
];

const parseUint32Tests = [
	{ in: "", out: 0n, err: numErr("ParseUint", "", errSyntax) },
	{ in: "0", out: 0n },
	{ in: "1", out: 1n },
	{ in: "12345", out: 12345n },
	{ in: "12345x", out: 0n, err: numErr("ParseUint", "12345x", errSyntax) },
	{ in: "987654321", out: 987654321n },
	{ in: "4294967296", out: (1n << 32n) - 1n, err: numErr("ParseUint", "4294967296", errRange) },
	{ in: "1_2_3_4_5", out: 0n, err: numErr("ParseUint", "1_2_3_4_5", errSyntax) },
	{ in: "12345_", out: 0n, err: numErr("ParseUint", "12345_", errSyntax) },
];

const parseInt32Tests = [
	{ in: "", out: 0n, err: numErr("ParseInt", "", errSyntax) },
	{ in: "0", out: 0n },
	{ in: "-0", out: 0n },
	{ in: "1", out: 1n },
	{ in: "-1", out: -1n },
	{ in: "12345", out: 12345n },
	{ in: "-12345", out: -12345n },
	{ in: "2147483648", out: (1n << 31n) - 1n, err: numErr("ParseInt", "2147483648", errRange) },
	{ in: "12345_", out: 0n, err: numErr("ParseInt", "12345_", errSyntax) },
];

const parseBitSizeTests = [
	{ arg: -1, err: new NumError("ParseInt", "0", new Error("invalid bit size -1")) },
	{ arg: 0 },
	{ arg: 64 },
	{ arg: 65, err: new NumError("ParseInt", "0", new Error("invalid bit size 65")) },
];

const parseBaseTests = [
	{ arg: -1, err: new NumError("ParseInt", "0", new Error("invalid base -1")) },
	{ arg: 0 },
	{ arg: 1, err: new NumError("ParseInt", "0", new Error("invalid base 1")) },
	{ arg: 2 },
	{ arg: 36 },
	{ arg: 37, err: new NumError("ParseInt", "0", new Error("invalid base 37")) },
];

interface QuoteUpstreamTestCase {
	in: string;
	out: string;
}

// Mirrors the ASCII/control-character subset of go stdlib strconv/quote_test.go quotetests.
// Cases that depend on invalid UTF-8 byte strings or Go's Unicode print tables are omitted.
const quoteTests: QuoteUpstreamTestCase[] = [
	{ in: "\x07\b\f\r\n\t\v", out: `"\\a\\b\\f\\r\\n\\t\\v"` },
	{ in: "\\", out: '"\\\\"' },
	{ in: "\x04", out: `"\\x04"` },
	{ in: "\x7f", out: `"\\x7f"` },
];

browser.describe("strconv", () => {
	// Models go stdlib strconv/quote_test.go TestQuote.
	it("TestQuote", () => {
		for (const test of quoteTests) {
			expect(quote(test.in)).toBe(test.out);
			const dst = appendQuote(["abc"], test.in);
			expect(dst.join("")).toBe(`abc${test.out}`);
		}
	});

	// Models go stdlib strconv/number_test.go TestParseUint32.
	it("TestParseUint32", () => {
		for (const test of parseUint32Tests) {
			const [out, err] = parseUint(test.in, 10, 32);
			expect(out).toBe(test.out);
			expect(errorString(err)).toBe(errorString(test.err));
		}
	});

	// Models go stdlib strconv/number_test.go TestParseUint64.
	it("TestParseUint64", () => {
		for (const test of parseUint64Tests) {
			const [out, err] = parseUint(test.in, 10, 64);
			expect(out).toBe(test.out);
			expect(errorString(err)).toBe(errorString(test.err));
		}
	});

	// Models go stdlib strconv/number_test.go TestParseUint64Base.
	it("TestParseUint64Base", () => {
		for (const test of parseUint64BaseTests) {
			const [out, err] = parseUint(test.in, test.base, 64);
			expect(out).toBe(test.out);
			expect(errorString(err)).toBe(errorString(test.err));
		}
	});

	// Models go stdlib strconv/number_test.go TestParseInt32.
	it("TestParseInt32", () => {
		for (const test of parseInt32Tests) {
			const [out, err] = parseInt(test.in, 10, 32);
			expect(out).toBe(test.out);
			expect(errorString(err)).toBe(errorString(test.err));
		}
	});

	// Models go stdlib strconv/number_test.go TestParseInt64.
	it("TestParseInt64", () => {
		for (const test of parseInt64Tests) {
			const [out, err] = parseInt(test.in, 10, 64);
			expect(out).toBe(test.out);
			expect(errorString(err)).toBe(errorString(test.err));
		}
	});

	// Models go stdlib strconv/number_test.go TestParseInt64Base.
	it("TestParseInt64Base", () => {
		for (const test of parseInt64BaseTests) {
			const [out, err] = parseInt(test.in, test.base, 64);
			expect(out).toBe(test.out);
			expect(errorString(err)).toBe(errorString(test.err));
		}
	});

	// Models go stdlib strconv/number_test.go TestParseIntBitSize.
	it("TestParseIntBitSize", () => {
		for (const test of parseBitSizeTests) {
			const [, err] = parseInt("0", 0, test.arg);
			expect(errorString(err)).toBe(errorString(test.err));
		}
	});

	// Models go stdlib strconv/number_test.go TestParseUintBitSize.
	it("TestParseUintBitSize", () => {
		for (const test of parseBitSizeTests) {
			const expected = test.err ? new NumError("ParseUint", "0", test.err.err) : undefined;
			const [, err] = parseUint("0", 0, test.arg);
			expect(errorString(err)).toBe(errorString(expected));
		}
	});

	// Models go stdlib strconv/number_test.go TestParseIntBase.
	it("TestParseIntBase", () => {
		for (const test of parseBaseTests) {
			const [, err] = parseInt("0", test.arg, 0);
			expect(errorString(err)).toBe(errorString(test.err));
		}
	});

	// Models go stdlib strconv/number_test.go TestParseUintBase.
	it("TestParseUintBase", () => {
		for (const test of parseBaseTests) {
			const expected = test.err ? new NumError("ParseUint", "0", test.err.err) : undefined;
			const [, err] = parseUint("0", test.arg, 0);
			expect(errorString(err)).toBe(errorString(expected));
		}
	});

	// Models go stdlib strconv/number_test.go TestNumError.
	it("TestNumError", () => {
		const tests = [
			{ num: "0", want: 'strconv.ParseFloat: parsing "0": failed' },
			{ num: "`", want: 'strconv.ParseFloat: parsing "`": failed' },
			{ num: "1\0.2", want: 'strconv.ParseFloat: parsing "1\\x00.2": failed' },
		];
		for (const test of tests) {
			const err = new NumError("ParseFloat", test.num, new Error("failed"));
			expect(err.message).toBe(test.want);
		}
	});
});

function errorString(err: Error | undefined): string | undefined {
	return err?.message;
}
