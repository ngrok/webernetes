import { expect, it } from "vitest";
import type { V1ServiceSpec } from "../../../../../client";
import { browser } from "../../../../../test/describe";
import { isServiceIPSet } from "./helpers";

// Models kubernetes/pkg/apis/core/helper/helpers_test.go TestIsServiceIPSet.
browser.describe("isServiceIPSet", () => {
	const testCases: Array<{
		input: V1ServiceSpec;
		output: boolean;
		name: string;
	}> = [
		{
			name: "nil cluster ip",
			input: {
				clusterIPs: undefined,
			},

			output: false,
		},
		{
			name: "headless service",
			input: {
				clusterIP: "None",
				clusterIPs: ["None"],
			},
			output: false,
		},
		// true cases
		{
			name: "one ipv4",
			input: {
				clusterIP: "1.2.3.4",
				clusterIPs: ["1.2.3.4"],
			},
			output: true,
		},
		{
			name: "one ipv6",
			input: {
				clusterIP: "2001::1",
				clusterIPs: ["2001::1"],
			},
			output: true,
		},
		{
			name: "v4, v6",
			input: {
				clusterIP: "1.2.3.4",
				clusterIPs: ["1.2.3.4", "2001::1"],
			},
			output: true,
		},
		{
			name: "v6, v4",
			input: {
				clusterIP: "2001::1",
				clusterIPs: ["2001::1", "1.2.3.4"],
			},

			output: true,
		},
	];

	for (const tc of testCases) {
		it(tc.name, () => {
			const s = {
				spec: tc.input,
			};
			expect(isServiceIPSet(s)).toBe(tc.output);
		});
	}
});
