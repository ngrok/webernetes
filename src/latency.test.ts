import { expect, it } from "vitest";

import type { NetworkHop } from "./cluster/cni/network";
import * as context from "./go/context";
import { getLatencyProvider, newLatencyProvider, withLatencyProvider } from "./latency";
import { browser } from "./test/describe";

browser.describe("LatencyProvider", () => {
	const chain: NetworkHop[] = [{ type: "external", host: "example.com" }];

	it("converts missing latency options to zero-returning functions", () => {
		const provider = newLatencyProvider();

		expect(provider.clusterNetworkRequestLatency(chain)).toBe(0);
		expect(provider.clusterNetworkResponseLatency(chain)).toBe(0);
	});

	it("passes the network hop chain to latency option functions", () => {
		let requestLatency = 1;
		let responseLatency = 10;
		const requestChains: Array<readonly NetworkHop[]> = [];
		const responseChains: Array<readonly NetworkHop[]> = [];
		const provider = newLatencyProvider({
			clusterNetworkRequestLatency: (chain) => {
				requestChains.push(chain);
				return requestLatency++;
			},
			clusterNetworkResponseLatency: (chain) => {
				responseChains.push(chain);
				return (responseLatency += 5);
			},
		});

		expect(provider.clusterNetworkRequestLatency(chain)).toBe(1);
		expect(provider.clusterNetworkRequestLatency(chain)).toBe(2);
		expect(provider.clusterNetworkResponseLatency(chain)).toBe(15);
		expect(provider.clusterNetworkResponseLatency(chain)).toBe(20);
		expect(requestChains).toEqual([chain, chain]);
		expect(responseChains).toEqual([chain, chain]);
	});

	it("stores and retrieves providers through context", () => {
		const provider = newLatencyProvider({
			clusterNetworkRequestLatency: () => 12,
			clusterNetworkResponseLatency: () => 34,
		});
		const ctx = withLatencyProvider(context.background(), provider);

		expect(getLatencyProvider(ctx)).toBe(provider);
	});

	it("falls back to the no-op provider when context has no latency provider", () => {
		const provider = getLatencyProvider(context.background());

		expect(provider.clusterNetworkRequestLatency(chain)).toBe(0);
		expect(provider.clusterNetworkResponseLatency(chain)).toBe(0);
	});
});
