// oxlint-disable jest/no-conditional-expect
import { expect, it } from "vitest";
import { browser } from "../../../../../test/describe";
import { isDecimalInteger } from "./decimal_int";

browser.describe("content decimal integer validation", () => {
	// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/decimal_int_test.go TestIsDecimalInteger.
	const testCases = [
		{ name: "zero", input: "0", shouldPass: true },
		{ name: "positive single digit 1", input: "1", shouldPass: true },
		{ name: "positive single digit 2", input: "2", shouldPass: true },
		{ name: "positive single digit 5", input: "5", shouldPass: true },
		{ name: "positive single digit 9", input: "9", shouldPass: true },
		{ name: "negative single digit", input: "-5", shouldPass: true },
		{ name: "negative single digit 1", input: "-1", shouldPass: true },
		{ name: "negative single digit 9", input: "-9", shouldPass: true },
		{ name: "number starting with 1", input: "100", shouldPass: true },
		{ name: "number starting with 2", input: "234", shouldPass: true },
		{ name: "number starting with 3", input: "345", shouldPass: true },
		{ name: "number starting with 4", input: "456", shouldPass: true },
		{ name: "number starting with 5", input: "567", shouldPass: true },
		{ name: "number starting with 6", input: "678", shouldPass: true },
		{ name: "number starting with 7", input: "789", shouldPass: true },
		{ name: "number starting with 8", input: "890", shouldPass: true },
		{ name: "number starting with 9", input: "999", shouldPass: true },
		{ name: "positive multi-digit", input: "123", shouldPass: true },
		{ name: "negative multi-digit", input: "-456", shouldPass: true },
		{ name: "negative starting with 1", input: "-100", shouldPass: true },
		{ name: "negative starting with 9", input: "-987", shouldPass: true },
		{ name: "large positive number", input: "9223372036854775807", shouldPass: true },
		{ name: "large negative number", input: "-9223372036854775808", shouldPass: true },
		{ name: "very long valid number", input: "12345678901234567890", shouldPass: true },
		{ name: "all nines", input: "999999999999", shouldPass: true },
		{ name: "negative zero", input: "-0", shouldPass: false },
		{ name: "double zero", input: "00", shouldPass: false },
		{ name: "triple zero", input: "000", shouldPass: false },
		{ name: "many zeros", input: "0000000", shouldPass: false },
		{ name: "leading zero single digit", input: "01", shouldPass: false },
		{ name: "leading zero digit 2", input: "02", shouldPass: false },
		{ name: "leading zero digit 9", input: "09", shouldPass: false },
		{ name: "leading zero multi-digit", input: "0123", shouldPass: false },
		{ name: "octal-like format", input: "0700", shouldPass: false },
		{ name: "octal-like format 2", input: "0950", shouldPass: false },
		{ name: "multiple leading zeros", input: "00123", shouldPass: false },
		{ name: "negative with leading zero", input: "-01", shouldPass: false },
		{ name: "negative with leading zeros", input: "-0123", shouldPass: false },
		{ name: "negative double zero", input: "-00", shouldPass: false },
		{ name: "plus sign", input: "+123", shouldPass: false },
		{ name: "positive plus sign", input: "+5", shouldPass: false },
		{ name: "plus zero", input: "+0", shouldPass: false },
		{ name: "empty string", input: "", shouldPass: false, errContains: "non-empty" },
		{ name: "just minus sign", input: "-", shouldPass: false },
		{ name: "just plus sign", input: "+", shouldPass: false },
		{ name: "single space", input: " ", shouldPass: false },
		{ name: "multiple spaces", input: "   ", shouldPass: false },
		{ name: "leading space", input: " 123", shouldPass: false },
		{ name: "trailing space", input: "123 ", shouldPass: false },
		{ name: "space in middle", input: "12 3", shouldPass: false },
		{ name: "spaces around", input: " 123 ", shouldPass: false },
		{ name: "decimal number", input: "12.3", shouldPass: false },
		{ name: "decimal zero", input: "0.0", shouldPass: false },
		{ name: "negative decimal", input: "-12.5", shouldPass: false },
		{ name: "trailing dot", input: "123.", shouldPass: false },
		{ name: "leading dot", input: ".123", shouldPass: false },
		{ name: "alphabetic", input: "abc", shouldPass: false },
		{ name: "alphanumeric", input: "12a3", shouldPass: false },
		{ name: "letter at start", input: "a123", shouldPass: false },
		{ name: "letter at end", input: "123a", shouldPass: false },
		{ name: "uppercase letters", input: "ABC", shouldPass: false },
		{ name: "mixed case", input: "12A3", shouldPass: false },
		{ name: "hexadecimal", input: "0x123", shouldPass: false },
		{ name: "hex uppercase", input: "0X123", shouldPass: false },
		{ name: "octal prefix", input: "0o777", shouldPass: false },
		{ name: "binary prefix", input: "0b101", shouldPass: false },
		{ name: "scientific notation", input: "1e5", shouldPass: false },
		{ name: "scientific negative exp", input: "1e-5", shouldPass: false },
		{ name: "scientific uppercase", input: "1E5", shouldPass: false },
		{ name: "underscore separator", input: "1_000", shouldPass: false },
		{ name: "comma separator", input: "1,000", shouldPass: false },
		{ name: "period separator", input: "1.000", shouldPass: false },
		{ name: "apostrophe separator", input: "1'000", shouldPass: false },
		{ name: "double minus", input: "--123", shouldPass: false },
		{ name: "double plus", input: "++123", shouldPass: false },
		{ name: "plus minus", input: "+-123", shouldPass: false },
		{ name: "minus plus", input: "-+123", shouldPass: false },
		{ name: "minus at end", input: "123-", shouldPass: false },
		{ name: "minus in middle", input: "12-3", shouldPass: false },
		{ name: "plus at end", input: "123+", shouldPass: false },
		{ name: "plus in middle", input: "12+3", shouldPass: false },
		{ name: "tab character at start", input: "\t123", shouldPass: false },
		{ name: "tab character at end", input: "123\t", shouldPass: false },
		{ name: "newline character", input: "123\n", shouldPass: false },
		{ name: "carriage return", input: "123\r", shouldPass: false },
		{ name: "null character", input: "123\u0000", shouldPass: false },
		{ name: "vertical tab", input: "123\v", shouldPass: false },
		{ name: "form feed", input: "123\f", shouldPass: false },
		{ name: "parentheses", input: "(123)", shouldPass: false },
		{ name: "brackets", input: "[123]", shouldPass: false },
		{ name: "braces", input: "{123}", shouldPass: false },
		{ name: "dollar sign", input: "$123", shouldPass: false },
		{ name: "percent sign", input: "123%", shouldPass: false },
		{ name: "hash", input: "#123", shouldPass: false },
		{ name: "at sign", input: "@123", shouldPass: false },
		{ name: "ampersand", input: "&123", shouldPass: false },
		{ name: "asterisk", input: "*123", shouldPass: false },
		{ name: "slash", input: "12/3", shouldPass: false },
		{ name: "backslash", input: "12\\3", shouldPass: false },
		{ name: "pipe", input: "12|3", shouldPass: false },
		{ name: "semicolon", input: "12;3", shouldPass: false },
		{ name: "colon", input: "12:3", shouldPass: false },
		{ name: "question mark", input: "12?3", shouldPass: false },
		{ name: "exclamation", input: "12!3", shouldPass: false },
		{ name: "tilde", input: "~123", shouldPass: false },
		{ name: "backtick", input: "`123", shouldPass: false },
		{ name: "single quote", input: "'123'", shouldPass: false },
		{ name: "double quote", input: '"123"', shouldPass: false },
		{ name: "unicode minus", input: "−123", shouldPass: false },
		{ name: "unicode digit", input: "１２３", shouldPass: false },
		{ name: "arabic digits", input: "١٢٣", shouldPass: false },
		{ name: "chinese characters", input: "一二三", shouldPass: false },
		{ name: "superscript", input: "123⁴", shouldPass: false },
		{ name: "subscript", input: "123₄", shouldPass: false },
	];

	it.each(testCases)("$name", (tc) => {
		const errs = isDecimalInteger(tc.input);
		if (tc.shouldPass) {
			expect(errs).toHaveLength(0);
		} else {
			expect(errs.length).not.toBe(0);
			if (tc.errContains) {
				expect(errs.some((err) => err.includes(tc.errContains))).toBe(true);
			}
		}
	});

	it("TestIsDecimalInteger additional verification", () => {
		const validCases = [
			"0",
			"1",
			"2",
			"5",
			"9",
			"-1",
			"-5",
			"-9",
			"123",
			"-456",
			"100",
			"999",
			"9223372036854775807",
			"-9223372036854775808",
			"12345678901234567890",
		];
		for (const validCase of validCases) {
			const errs = isDecimalInteger(validCase);
			expect(errs).toHaveLength(0);
			if (validCase.length <= 19) {
				expect(Number.parseInt(validCase, 10)).not.toBeNaN();
			}
		}

		const rejectedCases = [
			"0700",
			"0950",
			"01",
			"02",
			"09",
			"+123",
			"+5",
			"+0",
			"-0",
			"00",
			"000",
			"-01",
			"-00",
		];
		for (const rejectedCase of rejectedCases) {
			const errs = isDecimalInteger(rejectedCase);
			expect(errs.length).not.toBe(0);
		}

		const strconvAcceptsButWeReject = ["+123", "0700", "01"];
		for (const case_ of strconvAcceptsButWeReject) {
			expect(Number.parseInt(case_, 10)).not.toBeNaN();
			const errs = isDecimalInteger(case_);
			expect(errs.length).not.toBe(0);
		}
	});
});
