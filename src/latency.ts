import * as context from "./go/context";
import type { NetworkHop } from "./cluster/cni/network";

const key = Symbol("latencyProvider");
const noopValue = () => 0;
const noop = newLatencyProvider();

export interface LatencyProvider {
	clusterNetworkRequestLatency(chain: readonly NetworkHop[]): number;
	clusterNetworkResponseLatency(chain: readonly NetworkHop[]): number;
}

export function newLatencyProvider(options: Partial<LatencyProvider> = {}): LatencyProvider {
	return {
		clusterNetworkRequestLatency: options.clusterNetworkRequestLatency ?? noopValue,
		clusterNetworkResponseLatency: options.clusterNetworkResponseLatency ?? noopValue,
	};
}

export function withLatencyProvider(
	ctx: context.Context,
	latencyProvider?: LatencyProvider,
): context.Context {
	return context.withValue(ctx, key, latencyProvider ?? noop);
}

export function getLatencyProvider(ctx: context.Context): LatencyProvider {
	const latencyProvider = ctx.value(key);
	return isLatencyProvider(latencyProvider) ? latencyProvider : noop;
}

function isLatencyProvider(value: unknown): value is LatencyProvider {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as {
		clusterNetworkRequestLatency?: unknown;
		clusterNetworkResponseLatency?: unknown;
	};
	return (
		typeof candidate.clusterNetworkRequestLatency === "function" &&
		typeof candidate.clusterNetworkResponseLatency === "function"
	);
}
