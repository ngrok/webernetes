/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import type { V1Pod } from "../../../../client";
import { browser } from "../../../../test/describe";
import { isPodTerminal } from "./util";

browser.describe("pod util", () => {
	// Models kubernetes/pkg/api/v1/pod/util_test.go TestIsPodTerminal.
	it("IsPodTerminal", () => {
		const tests: Array<{
			podPhase?: string;
			expected: boolean;
		}> = [
			{
				podPhase: "Failed",
				expected: true,
			},
			{
				podPhase: "Succeeded",
				expected: true,
			},
			{
				podPhase: "Unknown",
				expected: false,
			},
			{
				podPhase: "Pending",
				expected: false,
			},
			{
				podPhase: "Running",
				expected: false,
			},
			{
				expected: false,
			},
		];

		for (const [i, test] of tests.entries()) {
			const isTerminal = isPodTerminal(pod(test.podPhase));
			expect({ i, isTerminal }).toEqual({ i, isTerminal: test.expected });
		}
	});
});

function pod(phase: string | undefined): V1Pod {
	return {
		status: {
			phase,
		},
	};
}
