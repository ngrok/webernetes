/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
/* eslint-disable jest/expect-expect */
import { it } from "vitest";
import { Aggregate, newAggregate } from "../../../apimachinery/pkg/util/errors/errors";
import { browser } from "../../../test/describe";
import { minBackoffExpiration, newBackoffError, newSyncResult, PodSyncResult } from "./sync-result";

// Models kubernetes/pkg/kubelet/container/sync_result_test.go TestPodSyncResult.
browser.describe("TestPodSyncResult", () => {
	it("matches upstream behavior", () => {
		const okResults = [
			newSyncResult("StartContainer", "container_0"),
			newSyncResult("CreatePodSandbox", "pod"),
		];
		const errResults = [
			newSyncResult("KillContainer", "container_1"),
			newSyncResult("KillPodSandbox", "pod"),
		];
		errResults[0].fail(new Error("error_0"), "message_0");
		errResults[1].fail(new Error("error_1"), "message_1");

		let result = new PodSyncResult();
		result.addSyncResult(...okResults);
		if (result.error() !== undefined) {
			throw new Error(`PodSyncResult should not be error: ${String(result)}`);
		}

		result = new PodSyncResult();
		result.addSyncResult(...okResults);
		result.addSyncResult(...errResults);
		if (result.error() === undefined) {
			throw new Error(`PodSyncResult should be error: ${String(result)}`);
		}

		result = new PodSyncResult();
		result.addSyncResult(...okResults);
		result.fail(new Error("error"));
		if (result.error() === undefined) {
			throw new Error(`PodSyncResult should be error: ${String(result)}`);
		}

		const errResult = new PodSyncResult();
		errResult.addSyncResult(...errResults);
		result = new PodSyncResult();
		result.addSyncResult(...okResults);
		result.addPodSyncResult(errResult);
		if (result.error() === undefined) {
			throw new Error(`PodSyncResult should be error: ${String(result)}`);
		}
	});
});

// Models kubernetes/pkg/kubelet/container/sync_result_test.go myCustomError.
class MyCustomError extends Error {
	constructor(readonly msg: string) {
		super(msg);
		this.name = "MyCustomError";
	}
}

// Models kubernetes/pkg/kubelet/container/sync_result_test.go TestPodSyncResultPreservesOriginalErrorType.
browser.describe("TestPodSyncResultPreservesOriginalErrorType", () => {
	it("with custom error in SyncResult", () => {
		const customErr = new MyCustomError("a special error");
		const syncResult = newSyncResult("KillContainer", "container_1");
		syncResult.fail(customErr, "a special message");
		const result = new PodSyncResult();
		result.syncResults = [syncResult];

		const aggErr = result.error();
		if (aggErr === undefined) {
			throw new Error("expected an aggregate error, but got nil");
		}

		if (!(aggErr instanceof Aggregate)) {
			throw new Error(`expected an aggregate error, but got ${aggErr.message}`);
		}
		const errs = aggErr.errors;
		let foundCustomErr = false;
		for (const err of errs) {
			const ce = errorAsCustomError(err, customErr);
			if (ce !== undefined && ce === customErr) {
				foundCustomErr = true;
			}
		}
		if (!foundCustomErr) {
			throw new Error(
				`expected custom error not found in aggregate error. got ${aggErr.message}, want ${customErr.message}`,
			);
		}
	});

	it("with custom error in SyncError", () => {
		const customErr = new MyCustomError("a special sync error");
		const result = new PodSyncResult();
		result.fail(customErr);

		const aggErr = result.error();
		if (aggErr === undefined) {
			throw new Error("expected an aggregate error for SyncError, but got nil");
		}

		if (!(aggErr instanceof Aggregate)) {
			throw new Error(`expected an aggregate error, but got ${aggErr.message}`);
		}
		const errs = aggErr.errors;
		let foundCustomErr = false;
		for (const err of errs) {
			const ce = errorAsCustomError(err, customErr);
			if (ce !== undefined && ce === customErr) {
				foundCustomErr = true;
			}
		}
		if (!foundCustomErr) {
			throw new Error(
				`expected custom error not found in aggregate error. got ${aggErr.message}, want ${customErr.message}`,
			);
		}
	});
});

// Models kubernetes/pkg/kubelet/container/sync_result_test.go TestMinBackoffExpiration.
browser.describe("TestMinBackoffExpiration", () => {
	const now = new Date("2026-01-02T03:04:05.000Z");
	const addSeconds = (seconds: number): Date => new Date(now.getTime() + seconds * 1000);
	const testCases: Array<{
		name: string;
		err: Error | undefined;
		expectedBackoff: Date | undefined;
		expectedFound: boolean;
	}> = [
		{
			name: "nil error",
			err: undefined,
			expectedBackoff: undefined,
			expectedFound: false,
		},
		{
			name: "simple error",
			err: new Error("generic error"),
			expectedBackoff: undefined,
			expectedFound: false,
		},
		{
			name: "BackoffError",
			err: newBackoffError(new Error("backoff"), addSeconds(5)),
			expectedBackoff: addSeconds(5),
			expectedFound: true,
		},
		{
			name: "wrapped BackoffError",
			err: errorfWrap("wrapped", newBackoffError(new Error("backoff"), addSeconds(3))),
			expectedBackoff: addSeconds(3),
			expectedFound: true,
		},
		{
			name: "aggregate with no BackoffError",
			err: mustAggregate([new Error("err1"), new Error("err2")]),
			expectedBackoff: undefined,
			expectedFound: false,
		},
		{
			name: "aggregate with one BackoffError",
			err: mustAggregate([new Error("err1"), newBackoffError(new Error("backoff"), addSeconds(7))]),
			expectedBackoff: addSeconds(7),
			expectedFound: true,
		},
		{
			name: "aggregate with multiple BackoffErrors, returns minimum",
			err: mustAggregate([
				newBackoffError(new Error("backoff1"), addSeconds(10)),
				newBackoffError(new Error("backoff2"), addSeconds(3)),
				new Error("err1"),
				newBackoffError(new Error("backoff3"), addSeconds(5)),
			]),
			expectedBackoff: addSeconds(3),
			expectedFound: true,
		},
		{
			name: "wrapped aggregate with BackoffError",
			err: errorfWrap(
				"wrapped",
				mustAggregate([
					newBackoffError(new Error("backoff1"), addSeconds(10)),
					newBackoffError(new Error("backoff2"), addSeconds(3)),
				]),
			),
			expectedBackoff: addSeconds(3),
			expectedFound: true,
		},
		{
			name: "nested aggregate with BackoffError",
			err: mustAggregate([
				new Error("err1"),
				mustAggregate([newBackoffError(new Error("backoff nested"), addSeconds(2))]),
				newBackoffError(new Error("backoff outer"), addSeconds(4)),
			]),
			expectedBackoff: addSeconds(2),
			expectedFound: true,
		},
	];

	for (const tc of testCases) {
		it(tc.name, () => {
			const [backoff, found] = minBackoffExpiration(tc.err);
			if (found !== tc.expectedFound) {
				throw new Error(`expected found=${tc.expectedFound}, got ${found}`);
			}
			if (!datesEqual(backoff, tc.expectedBackoff)) {
				throw new Error(`expected backoff=${String(tc.expectedBackoff)}, got ${String(backoff)}`);
			}
		});
	}
});

function errorAsCustomError(err: unknown, customErr: MyCustomError): MyCustomError | undefined {
	if (!(err instanceof Error)) {
		return undefined;
	}
	if (err instanceof MyCustomError && err === customErr) {
		return err;
	}
	if (err.cause !== undefined) {
		return errorAsCustomError(err.cause, customErr);
	}
	return undefined;
}

function mustAggregate(errlist: Error[]): Aggregate {
	const aggregate = newAggregate(errlist);
	if (!aggregate) {
		throw new Error("expected aggregate error");
	}
	return aggregate;
}

function errorfWrap(message: string, err: Error): Error {
	return new Error(`${message}: ${err.message}`, { cause: err });
}

function datesEqual(a: Date | undefined, b: Date | undefined): boolean {
	return a?.getTime() === b?.getTime();
}
