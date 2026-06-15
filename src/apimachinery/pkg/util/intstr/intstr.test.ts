/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import type { IntOrString } from "../../../../client";
import { browser } from "../../../../test/describe";
import { getIntOrPercentValueSafely, getScaledValueFromIntOrPercent } from "./intstr";

browser.describe("intstr", () => {
	// Models staging/src/k8s.io/apimachinery/pkg/util/intstr/intstr_test.go TestGetIntFromIntOrString.
	it("gets int or percent value safely", () => {
		const tests: Array<{
			input: IntOrString;
			expectErr: boolean;
			expectVal?: number;
			expectPerc?: boolean;
		}> = [
			{
				input: 200,
				expectErr: false,
				expectVal: 200,
				expectPerc: false,
			},
			{
				input: "200",
				expectErr: true,
			},
			{
				input: "30%0",
				expectErr: true,
			},
			{
				input: "40%",
				expectErr: false,
				expectVal: 40,
				expectPerc: true,
			},
			{
				input: "%",
				expectErr: true,
			},
			{
				input: "a%",
				expectErr: true,
			},
			{
				input: "a",
				expectErr: true,
			},
			{
				input: "40#",
				expectErr: true,
			},
			{
				input: "40%%",
				expectErr: true,
			},
		];

		for (const test of tests) {
			const [value, isPercent, err] = getIntOrPercentValueSafely(test.input);
			expect(value).toBe(test.expectVal ?? 0);
			expect(isPercent).toBe(test.expectPerc ?? false);
			expect(err !== undefined).toBe(test.expectErr);
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/util/intstr/intstr_test.go TestGetIntFromIntOrPercent.
	it("gets scaled value from int or percent", () => {
		const tests: Array<{
			input: IntOrString;
			total?: number;
			roundUp?: boolean;
			expectErr: boolean;
			expectVal?: number;
		}> = [
			{
				input: 123,
				expectErr: false,
				expectVal: 123,
			},
			{
				input: "90%",
				total: 100,
				roundUp: true,
				expectErr: false,
				expectVal: 90,
			},
			{
				input: "90%",
				total: 95,
				roundUp: true,
				expectErr: false,
				expectVal: 86,
			},
			{
				input: "90%",
				total: 95,
				roundUp: false,
				expectErr: false,
				expectVal: 85,
			},
			{
				input: "%",
				expectErr: true,
			},
			{
				input: "90#",
				expectErr: true,
			},
			{
				input: "#%",
				expectErr: true,
			},
			{
				input: "90",
				expectErr: true,
			},
		];

		for (const test of tests) {
			const [value, err] = getScaledValueFromIntOrPercent(
				test.input,
				test.total ?? 0,
				test.roundUp ?? false,
			);
			expect(err !== undefined).toBe(test.expectErr);
			expect(value).toBe(test.expectVal ?? 0);
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/util/intstr/intstr_test.go TestGetValueFromIntOrPercentNil.
	it("returns an error for nil int or percent", () => {
		const [, err] = getScaledValueFromIntOrPercent(undefined, 0, false);
		expect(err).toBeInstanceOf(Error);
	});
});
