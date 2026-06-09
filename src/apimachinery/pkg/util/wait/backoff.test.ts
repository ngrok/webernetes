/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// oxlint-disable jest/expect-expect
import { expect, it } from "vitest";

import { Clock } from "../../../../clock";
import { Channel } from "../../../../go/channel";
import * as context from "../../../../go/context";
import { WaitGroup } from "../../../../go/sync/wait-group";
import { browser } from "../../../../test/describe";
import { untilWithContext } from "./backoff";

browser.describe("untilWithContext", () => {
	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/wait_test.go TestUntilWithContext.
	it("loops until context cancellation", async () => {
		const clock = new Clock();
		const [ctx, cancel] = context.withCancel(context.background());
		const called = new Channel<void>();
		const wg = new WaitGroup();

		wg.add(1);
		void (async () => {
			try {
				await untilWithContext(ctx, () => called.send(undefined), 0, clock);
				called.close();
			} finally {
				wg.done();
			}
		})();

		await called.receive();
		cancel();
		await called.receive();
		await wg.wait();
	});

	it("does not run when context is already canceled", async () => {
		const clock = new Clock();
		const [ctx, cancel] = context.withCancel(context.background());
		cancel();
		let calls = 0;

		await untilWithContext(
			ctx,
			() => {
				calls++;
			},
			10,
			clock,
		);

		expect(calls).toBe(0);
	});
});
