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

	// package main
	//
	// import "sync"
	//
	// func main() {
	// 	var once sync.Once
	// 	once.Do(func() {})
	// }
	//
	// Output:
	it("returns synchronously for synchronous functions", () => {
		const once = new Once();
		const result: void = once.do(() => {});

		expect(result).toBeUndefined();
	});

	// TypeScript extension: async callbacks model goroutines waiting for Do to finish.
	it("returns a promise for asynchronous functions", async () => {
		const once = new Once();
		let value = 0;
		const result: Promise<void> = once.do(async () => {
			value = 1;
		});

		await result;
		expect(value).toBe(1);
	});
});
