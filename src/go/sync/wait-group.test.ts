import { expect, it } from "vitest";

import { browser } from "../../test/describe";
import { WaitGroup } from "./wait-group";

browser.describe("WaitGroup", () => {
	it("waits until all work is done", async () => {
		const wg = new WaitGroup();
		let completed = false;

		wg.add(1);
		const wait = wg.wait().then(() => {
			completed = true;
			return undefined;
		});

		await Promise.resolve();
		expect(completed).toBe(false);

		wg.done();
		await wait;
		expect(completed).toBe(true);
	});

	it("rejects negative counters", () => {
		const wg = new WaitGroup();

		expect(() => wg.done()).toThrow("sync: negative WaitGroup counter");
	});
});
