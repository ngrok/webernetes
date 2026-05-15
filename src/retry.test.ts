import { expect, it } from "vitest";
import { Clock } from "./clock";
import { backoffDelayMs, retry } from "./retry";

it("retries failed operations", async () => {
	const clock = new Clock();
	let attempts = 0;

	const result = await retry(
		async () => {
			attempts++;
			if (attempts < 3) {
				throw new Error("try again");
			}
			return "ok";
		},
		{
			clock,
			retries: 2,
			baseDelayMs: 0,
			jitterRatio: 0,
		},
	);

	expect(result).toBe("ok");
	expect(attempts).toBe(3);
});

it("does not retry errors rejected by the retry predicate", async () => {
	const clock = new Clock();
	let attempts = 0;

	await expect(
		retry(
			async () => {
				attempts++;
				throw new Error("do not retry");
			},
			{
				clock,
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
