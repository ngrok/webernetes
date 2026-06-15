// oxlint-disable vitest/no-conditional-expect
/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import type { V1LabelSelector } from "../../../../../client";
import { browser } from "../../../../../test/describe";
import { everything, nothing, parse, type Selector } from "../../../labels/selector";
import { labelSelectorAsSelector } from "./helpers";

browser.describe("meta v1 helpers", () => {
	// Models staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/helpers_test.go TestLabelSelectorAsSelector.
	it("TestLabelSelectorAsSelector", () => {
		const matchLabels = { foo: "bar" };
		const matchExpressions = [
			{
				key: "baz",
				operator: "In" as const,
				values: ["qux", "norf"],
			},
		];
		const mustParse = (s: string): Selector => {
			const [out, err] = parse(s);
			if (err || !out) {
				throw err ?? new Error("expected selector");
			}
			return out;
		};
		const tests: Array<{
			in?: V1LabelSelector;
			out?: Selector;
			expectErr?: boolean;
		}> = [
			{ in: undefined, out: nothing() },
			{ in: {}, out: everything() },
			{
				in: { matchLabels },
				out: mustParse("foo=bar"),
			},
			{
				in: { matchExpressions },
				out: mustParse("baz in (norf,qux)"),
			},
			{
				in: { matchLabels, matchExpressions },
				out: mustParse("baz in (norf,qux),foo=bar"),
			},
			{
				in: {
					matchExpressions: [
						{
							key: "baz",
							operator: "Exists",
							values: ["qux", "norf"],
						},
					],
				},
				expectErr: true,
			},
		];

		for (const [i, test] of tests.entries()) {
			const inCopy = structuredClone(test.in);
			const [out, err] = labelSelectorAsSelector(test.in);
			expect({ i, input: test.in }).toEqual({ i, input: inCopy });
			expect({ i, hasErr: err !== undefined }).toEqual({
				i,
				hasErr: test.expectErr === true,
			});
			if (!err) {
				expect({ i, out: out?.string() }).toEqual({ i, out: test.out?.string() });
			}
		}
	});
});
