import type { Clock } from "./clock";

export interface RetryConflictOptions {
	clock: Clock;
	attempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	jitterRatio?: number;
}

export async function retryConflicts<T>(
	update: () => Promise<T>,
	{
		attempts = 5,
		baseDelayMs = 10,
		maxDelayMs = 250,
		jitterRatio = 0.2,
		clock,
	}: RetryConflictOptions,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await update();
		} catch (error) {
			if (isConflictError(error)) {
				lastError = error;
				if (attempt < attempts - 1) {
					const delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs, jitterRatio);
					await clock.wait(delayMs);
				}
				continue;
			}
			throw error;
		}
	}
	if (lastError) {
		throw lastError;
	}
	throw new Error("retryConflicts called with no attempts");
}

function backoffDelayMs(
	attempt: number,
	baseDelayMs: number,
	maxDelayMs: number,
	jitterRatio: number,
): number {
	const exponentialDelayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
	const jitterMs = exponentialDelayMs * jitterRatio * (Math.random() * 2 - 1);
	return Math.max(0, Math.round(exponentialDelayMs + jitterMs));
}

export function isConflictError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "Conflict" || error.message.includes("HTTP-Code: 409"))
	);
}
