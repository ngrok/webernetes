// Models kubernetes/pkg/kubelet/container/sync_result.go BackoffError.
export class BackoffError extends Error {
	constructor(
		error: Error,
		private readonly backoffExpiration: Date,
	) {
		super(error.message, { cause: error });
		this.name = "BackoffError";
	}

	// Models kubernetes/pkg/kubelet/container/sync_result.go BackoffError.BackoffTime.
	backoffTime(): Date {
		return this.backoffExpiration;
	}
}

// Models kubernetes/pkg/kubelet/container/sync_result.go NewBackoffError.
export function newBackoffError(error: Error, backoffTime: Date): BackoffError {
	return new BackoffError(error, backoffTime);
}

// Models kubernetes/pkg/kubelet/container/sync_result.go MinBackoffExpiration.
export function minBackoffExpiration(error: unknown): [Date | undefined, boolean] {
	if (error instanceof BackoffError) {
		return [error.backoffTime(), true];
	}

	if (error instanceof AggregateError) {
		let min: Date | undefined;
		let found = false;
		for (const err of error.errors as unknown[]) {
			const [backoff, ok] = minBackoffExpiration(err);
			if (ok && backoff && (!found || backoff < (min as Date))) {
				min = backoff;
				found = true;
			}
		}
		return [min, found];
	}

	if (error instanceof Error && error.cause !== undefined) {
		return minBackoffExpiration(error.cause);
	}

	return [undefined, false];
}
