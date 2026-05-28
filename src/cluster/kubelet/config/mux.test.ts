import { expect, it, vi } from "vitest";

import type { V1Pod } from "../../../client";
import { Channel } from "../../../go/channel";
import * as context from "../../../go/context";
import { browser } from "../../../test/describe";
import type { Merger } from "./mux";
import { newMux } from "./mux";
import type { SourceUpdate } from "./config";

browser.describe("mux", () => {
	// Models kubernetes/pkg/kubelet/config/mux_test.go TestConfigurationChannels.
	it("returns stable channels by source name", () => {
		const [ctx, cancel] = context.withCancel(context.background());
		try {
			const mux = newMux(undefined as unknown as Merger);
			const channelOne = mux.channelWithContext(ctx, "one");
			expect(channelOne).toBe(mux.channelWithContext(ctx, "one"));
			const channelTwo = mux.channelWithContext(ctx, "two");
			expect(channelOne).not.toBe(channelTwo);
		} finally {
			cancel();
		}
	});

	// Models kubernetes/pkg/kubelet/config/mux_test.go TestMergeInvoked.
	it("invokes merge for source updates", async () => {
		const [ctx, cancel] = context.withCancel(context.background());
		try {
			const expectedSource = "one";
			const done = new Channel<void>();
			const merger = mergeFunc(async (_ctx, source, update) => {
				expect(source).toBe(expectedSource);
				expect(update).toEqual(fakeUpdate(expectedSource));
				await done.send();
				return undefined;
			});

			const mux = newMux(merger);
			await mux.channelWithContext(ctx, expectedSource).send(fakeUpdate(expectedSource));

			const result = await done.receive();
			expect(result.ok).toBe(true);
		} finally {
			cancel();
		}
	});

	// Models kubernetes/pkg/kubelet/config/mux_test.go TestSimultaneousMerge.
	it("merges simultaneous source updates", async () => {
		const [ctx, cancel] = context.withCancel(context.background());
		try {
			const ch = new Channel<boolean>(2);
			const mux = newMux(
				mergeFunc(async (_ctx, source, update) => {
					const nsSource = update.pods[0]?.metadata?.namespace;
					expect(nsSource).toBe(source);
					await ch.send(true);
					return undefined;
				}),
			);
			const source = mux.channelWithContext(ctx, "one");
			const source2 = mux.channelWithContext(ctx, "two");
			await Promise.all([source.send(fakeUpdate("one")), source2.send(fakeUpdate("two"))]);
			await ch.receive();
			await ch.receive();
		} finally {
			cancel();
		}
	});

	it("stops listening when context is canceled", async () => {
		const [ctx, cancel] = context.withCancel(context.background());
		const merger = mergeFunc(() => undefined);
		const mux = newMux(merger);
		const source = mux.channelWithContext(ctx, "one");
		const merge = vi.spyOn(merger, "merge");

		cancel();
		await Promise.resolve();
		expect(source.trySend(fakeUpdate("one"))).toBe(false);
		expect(merge).not.toHaveBeenCalled();
	});
});

function mergeFunc(fn: Merger["merge"]): Merger {
	return { merge: fn };
}

function fakeUpdate(source: string): SourceUpdate {
	return {
		pods: [
			{
				metadata: {
					name: `${source}-pod`,
					namespace: source,
					uid: `${source}-pod-uid`,
				},
			} satisfies V1Pod,
		],
	};
}
