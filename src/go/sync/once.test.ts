/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import { browser } from "../../test/describe";
import { Channel } from "../channel";
import { Once } from "./once";

browser.describe("Once", () => {
	// Models Go src/sync/once_test.go TestOnce.
	it("runs the function once", async () => {
		let value = 0;
		const once = new Once();
		const c = new Channel<boolean>(10);

		for (let i = 0; i < 10; i++) {
			void (async () => {
				await once.do(() => {
					value++;
				});
				expect(value).toBe(1);
				await c.send(true);
			})();
		}
		for (let i = 0; i < 10; i++) {
			await c.receive();
		}
		expect(value).toBe(1);
	});

	// Models Go src/sync/once_test.go TestOncePanic.
	it("does not run the function again after panic", () => {
		const once = new Once();
		expect(() =>
			once.do(() => {
				throw new Error("failed");
			}),
		).toThrow("failed");

		once.do(() => {
			throw new Error("Once.Do called twice");
		});
	});
});
