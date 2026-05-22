import { expect, it } from "vitest";
import { browser } from "../../../test/describe";
import { newSyncResult, PodSyncResult } from "./sync-result";

browser.describe("PodSyncResult", () => {
	it("returns an aggregate for a single sync result error", () => {
		const syncResult = newSyncResult("StartContainer", "container-1");
		const cause = new Error("start failed");
		syncResult.fail(cause, "runtime message");

		const podSyncResult = new PodSyncResult();
		podSyncResult.addSyncResult(syncResult);

		const error = podSyncResult.error();

		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toHaveLength(1);
		expect((error as AggregateError).errors[0]).toHaveProperty("cause", cause);
	});
});
