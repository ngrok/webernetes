export type MaybePromise<T> = T | Promise<T>;

export function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
