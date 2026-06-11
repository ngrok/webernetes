import { getClock } from "./clock-context";
import { isConflictError } from "./client/errors";
import type * as context from "./go/context";

export interface RetryOptions {
	retries?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	jitterRatio?: number;
	shouldRetry?: (error: unknown) => boolean | Promise<boolean>;
}

export interface RetryConflictOptions {
	attempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	jitterRatio?: number;
}

export async function retry<T>(
	ctx: context.Context,
	operation: () => Promise<T>,
	{
		retries = 0,
		baseDelayMs = 10,
		maxDelayMs = 250,
		jitterRatio = 0.2,
		shouldRetry = () => true,
	}: RetryOptions = {},
): Promise<T> {
	const clock = getClock(ctx);
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
	ctx: context.Context,
	update: () => Promise<T>,
	{
		attempts = 5,
		baseDelayMs = 10,
		maxDelayMs = 250,
		jitterRatio = 0.2,
	}: RetryConflictOptions = {},
): Promise<T> {
	return await retry(ctx, update, {
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
