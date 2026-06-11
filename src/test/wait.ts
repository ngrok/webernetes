import { vi } from "vitest";
import { currentTestEnvironment } from "./describe";

const WAIT_FOR_OPTIONS =
	currentTestEnvironment === "browser"
		? { timeout: 5_000, interval: 50 }
		: { timeout: 180_000, interval: 500 };

export async function waitFor(assertion: () => unknown | Promise<unknown>): Promise<void> {
	await vi.waitFor(assertion, WAIT_FOR_OPTIONS);
}
