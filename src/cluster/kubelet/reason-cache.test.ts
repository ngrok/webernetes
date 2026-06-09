/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import { browser } from "../../test/describe";
import { newSyncResult, PodSyncResult, type SyncResult } from "./container";
import { newReasonCache, type ReasonCache } from "./reason-cache";

// Models kubernetes/pkg/kubelet/reason_cache_test.go TestReasonCache.
browser.describe("ReasonCache", () => {
	it("updates only failed StartContainer sync results", () => {
		const syncResult = new PodSyncResult();
		const results = [
			newSyncResult("StartContainer", "container_1"),
			newSyncResult("StartContainer", "container_2"),
			newSyncResult("KillContainer", "container_3"),
		];
		const runContainerErr = new Error("RunContainerError");
		const killContainerErr = new Error("KillContainerError");
		results[0]?.fail(runContainerErr, "message_1");
		results[2]?.fail(killContainerErr, "message_3");
		syncResult.addSyncResult(...results);
		const uid = "pod_1";

		const reasonCache = newReasonCache();
		reasonCache.update(uid, syncResult);

		assertReasonInfo(reasonCache, uid, results[0], true);
		assertReasonInfo(reasonCache, uid, results[1], false);
		assertReasonInfo(reasonCache, uid, results[2], false);

		reasonCache.remove(uid, String(results[0]?.target));
		assertReasonInfo(reasonCache, uid, results[0], false);
	});
});

function assertReasonInfo(
	cache: ReasonCache,
	uid: string,
	result: SyncResult | undefined,
	found: boolean,
): void {
	if (!result) {
		throw new Error("missing sync result");
	}
	const name = String(result.target);
	const [actualReason, ok] = cache.get(uid, name);
	if (ok && !found) {
		throw new Error(`unexpected cache hit: ${actualReason?.err.message}, ${actualReason?.message}`);
	}
	if (!ok && found) {
		throw new Error("corresponding reason info not found");
	}
	if (!found) {
		return;
	}
	expect(actualReason?.err).toBe(result.error);
	expect(actualReason?.message).toBe(result.message);
}
