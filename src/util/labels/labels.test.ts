/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import type { V1LabelSelector } from "../../client";
import { browser } from "../../test/describe";
import { cloneSelectorAndAddLabel } from "./labels";

browser.describe("util labels", () => {
	// Models kubernetes/pkg/util/labels/labels_test.go TestCloneSelectorAndAddLabel.
	it("clones selector and adds label", () => {
		const labels = {
			foo1: "bar1",
			foo2: "bar2",
			foo3: "bar3",
		};
		const matchExpressions = [
			{
				key: "foo",
				operator: "In",
				values: ["foo"],
			},
		];

		const cases: {
			labels?: Record<string, string>;
			labelKey: string;
			labelValue: string;
			want?: Record<string, string>;
		}[] = [
			{
				labels,
				labelKey: "",
				labelValue: "",
				want: labels,
			},
			{
				labels,
				labelKey: "foo4",
				labelValue: "89",
				want: {
					foo1: "bar1",
					foo2: "bar2",
					foo3: "bar3",
					foo4: "89",
				},
			},
			{
				labelKey: "foo4",
				labelValue: "12",
				want: {
					foo4: "12",
				},
			},
		];

		for (const tc of cases) {
			const lsIn: V1LabelSelector = {
				matchLabels: tc.labels,
				matchExpressions,
			};
			const got = cloneSelectorAndAddLabel(lsIn, tc.labelKey, tc.labelValue);

			expect(got).toEqual({
				matchLabels: tc.want,
				matchExpressions,
			});
		}
	});
});
