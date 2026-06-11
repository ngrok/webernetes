/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import { Channel } from "../../../../go/channel";
import * as context from "../../../../go/context";
import { WaitGroup } from "../../../../go/sync/wait-group";
import { browser } from "../../../../test/describe";
import { untilWithContext } from "./backoff";

browser.describe("untilWithContext", ({ ctx }) => {
	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/wait_test.go TestUntilWithContext.
	it("loops until context cancellation", async () => {
		const [childCtx, cancel] = context.withCancel(ctx);
		const called = new Channel<void>();
		const wg = new WaitGroup();

		wg.add(1);
		void (async () => {
			try {
				await untilWithContext(childCtx, () => called.send(undefined), 0);
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
		const [childCtx, cancel] = context.withCancel(ctx);
		cancel();
		let calls = 0;

		await untilWithContext(
			childCtx,
			() => {
				calls++;
			},
			10,
		);

		expect(calls).toBe(0);
	});
});
