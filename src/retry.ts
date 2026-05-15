import type { Clock } from "./clock";
import { isConflictError } from "./client/errors";

export interface RetryOptions {
	clock: Clock;
	retries?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	jitterRatio?: number;
	shouldRetry?: (error: unknown) => boolean | Promise<boolean>;
}

export interface RetryConflictOptions {
	clock: Clock;
	attempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	jitterRatio?: number;
}

export async function retry<T>(
	operation: () => Promise<T>,
	{
		retries = 0,
		baseDelayMs = 10,
		maxDelayMs = 250,
		jitterRatio = 0.2,
		shouldRetry = () => true,
		clock,
	}: RetryOptions,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await operation();
		} catch (error) {
			if (!(await shouldRetry(error))) {
				throw error;
			}
			lastError = error;
			if (attempt < retries) {
				await clock.wait(backoffDelayMs(attempt, baseDelayMs, maxDelayMs, jitterRatio));
			}
		}
	}

	throw lastError ?? new Error("retry called with no attempts");
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
	return await retry(update, {
		clock,
		retries: attempts - 1,
		baseDelayMs,
		maxDelayMs,
		jitterRatio,
		shouldRetry: isConflictError,
	});
}

export function backoffDelayMs(
	attempt: number,
	baseDelayMs: number,
	maxDelayMs: number,
	jitterRatio: number,
): number {
	const exponentialDelayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
	const jitterMs = exponentialDelayMs * jitterRatio * (Math.random() * 2 - 1);
	return Math.max(0, Math.round(exponentialDelayMs + jitterMs));
}
