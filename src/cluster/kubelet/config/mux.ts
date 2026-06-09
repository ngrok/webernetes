/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { Channel, select } from "../../../go/channel";
import type * as context from "../../../go/context";
import type { MaybePromise } from "../../../promise";
import type { SourceUpdate } from "./config";

// Models kubernetes/pkg/kubelet/config/mux.go merger.
export interface Merger {
	merge(
		ctx: context.Context,
		source: string,
		update: SourceUpdate,
	): MaybePromise<Error | undefined>;
}

// Models kubernetes/pkg/kubelet/config/mux.go mux.
export class Mux {
	private readonly sources = new Map<string, Channel<SourceUpdate>>();

	constructor(private readonly merger: Merger) {}

	// Models kubernetes/pkg/kubelet/config/mux.go mux.ChannelWithContext.
	channelWithContext(ctx: context.Context, source: string): Channel<SourceUpdate> {
		if (source.length === 0) {
			throw new Error("Channel given an empty name");
		}
		const channel = this.sources.get(source);
		if (channel) {
			return channel;
		}
		const newChannel = new Channel<SourceUpdate>();
		this.sources.set(source, newChannel);

		void this.listen(ctx, source, newChannel);
		return newChannel;
	}

	// Models kubernetes/pkg/kubelet/config/mux.go mux.listen.
	private async listen(
		ctx: context.Context,
		source: string,
		listenChannel: Channel<SourceUpdate>,
	): Promise<void> {
		for (;;) {
			// Simulator-specific: cluster shutdown closes ctx, but source channels are not
			// guaranteed to close, so we also wait on ctx.done() to stop this listener.
			const selected = await select()
				.case(ctx.done(), () => ({ type: "done" }) as const)
				.case(listenChannel, (result) => ({ type: "update", result }) as const);
			if (selected.type === "done") {
				return;
			}
			if (!selected.result.ok) {
				return;
			}
			await this.merger.merge(ctx, source, selected.result.value);
		}
	}
}

// Models kubernetes/pkg/kubelet/config/mux.go newMux.
export function newMux(merger: Merger): Mux {
	return new Mux(merger);
}
