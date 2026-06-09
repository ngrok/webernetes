/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { newAggregate } from "../../../apimachinery/pkg/util/errors/errors";

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

// Models kubernetes/pkg/kubelet/container/sync_result.go SyncAction.
export type SyncAction =
	| "StartContainer"
	| "KillContainer"
	| "InitContainer"
	| "CreatePodSandbox"
	| "ConfigPodSandbox"
	| "KillPodSandbox"
	| "ResizePodInPlace"
	| "RemoveContainer";

// Models kubernetes/pkg/kubelet/container/sync_result.go SyncResult.
export class SyncResult {
	error: Error | undefined;
	message = "";

	constructor(
		readonly action: SyncAction,
		readonly target: unknown,
	) {}

	// Models kubernetes/pkg/kubelet/container/sync_result.go SyncResult.Fail.
	fail(error: Error, message: string): void {
		this.error = error;
		this.message = message;
	}
}

// Models kubernetes/pkg/kubelet/container/sync_result.go NewSyncResult.
export function newSyncResult(action: SyncAction, target: unknown): SyncResult {
	return new SyncResult(action, target);
}

// Models kubernetes/pkg/kubelet/container/sync_result.go PodSyncResult.
export class PodSyncResult {
	syncResults: SyncResult[] = [];
	syncError: Error | undefined;

	// Models kubernetes/pkg/kubelet/container/sync_result.go PodSyncResult.AddSyncResult.
	addSyncResult(...results: SyncResult[]): void {
		this.syncResults.push(...results);
	}

	// Models kubernetes/pkg/kubelet/container/sync_result.go PodSyncResult.AddPodSyncResult.
	addPodSyncResult(result: PodSyncResult): void {
		this.addSyncResult(...result.syncResults);
		this.syncError = result.syncError;
	}

	// Models kubernetes/pkg/kubelet/container/sync_result.go PodSyncResult.Fail.
	fail(error: Error): void {
		this.syncError = error;
	}

	// Models kubernetes/pkg/kubelet/container/sync_result.go PodSyncResult.Error.
	error(): Error | undefined {
		const errlist: Error[] = [];
		if (this.syncError) {
			errlist.push(
				new Error(`failed to SyncPod: ${this.syncError.message}`, { cause: this.syncError }),
			);
		}
		for (const result of this.syncResults) {
			if (!result.error) {
				continue;
			}
			errlist.push(
				new Error(
					`failed to "${result.action}" for "${String(result.target)}" with ${result.error.message}: "${result.message}"`,
					{ cause: result.error },
				),
			);
		}
		return newAggregate(errlist);
	}
}
