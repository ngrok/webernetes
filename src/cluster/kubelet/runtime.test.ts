/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import { Clock } from "../../clock";
import { browser } from "../../test/describe";
import { RuntimeHandler } from "./container";
import { RuntimeState } from "./runtime";

// Models kubernetes/pkg/kubelet/runtime_test.go TestRuntimeStateSetRuntimeHandlersSortsAndCopies.
browser.describe("runtimeStateSetRuntimeHandlersSortsAndCopies", () => {
	const testCases: Array<{
		name: string;
		handlers: RuntimeHandler[];
		expected: string[];
	}> = [
		{
			name: "unsortedWithDefault",
			handlers: [
				new RuntimeHandler({ name: "runc" }),
				new RuntimeHandler({ name: "" }),
				new RuntimeHandler({ name: "crun" }),
			],
			expected: ["", "crun", "runc"],
		},
		{
			name: "alreadySorted",
			handlers: [
				new RuntimeHandler({ name: "" }),
				new RuntimeHandler({ name: "crun" }),
				new RuntimeHandler({ name: "runc" }),
			],
			expected: ["", "crun", "runc"],
		},
		{
			name: "emptyHandlers",
			handlers: [],
			expected: [],
		},
	];

	for (const tt of testCases) {
		it(tt.name, () => {
			const state = new RuntimeState(0, new Clock());
			const input = tt.handlers.map((handler) => handler.clone());
			const original = input.map((handler) => handler.clone());

			state.setRuntimeHandlers(input);

			expect(input).toEqual(original);

			const got = state.runtimeHandlers();
			expect(got).toHaveLength(tt.expected.length);
			for (const [i, name] of tt.expected.entries()) {
				expect(got[i]?.name).toBe(name);
			}
		});
	}
});
