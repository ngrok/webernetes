import { expect, it } from "vitest";
import { backoffDelayMs, retry } from "./retry";
import { browser } from "./test/describe";

browser.describe("retry", ({ ctx }) => {
	it("retries failed operations", async () => {
		let attempts = 0;

		const result = await retry(
			ctx,
			async () => {
				attempts++;
				if (attempts < 3) {
					throw new Error("try again");
				}
				return "ok";
			},
			{
				retries: 2,
				baseDelayMs: 0,
				jitterRatio: 0,
			},
		);

		expect(result).toBe("ok");
		expect(attempts).toBe(3);
	});

	it("does not retry errors rejected by the retry predicate", async () => {
		let attempts = 0;

		await expect(
			retry(
				ctx,
				async () => {
					attempts++;
					throw new Error("do not retry");
				},
				{
					retries: 2,
					shouldRetry: () => false,
				},
			),
		).rejects.toThrow("do not retry");

		expect(attempts).toBe(1);
	});

	it("computes exponential backoff delays", () => {
		expect(backoffDelayMs(0, 10, 100, 0)).toBe(10);
		expect(backoffDelayMs(1, 10, 100, 0)).toBe(20);
		expect(backoffDelayMs(4, 10, 100, 0)).toBe(100);
	});
});
