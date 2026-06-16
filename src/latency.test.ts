import { expect, it } from "vitest";

import type {
	NetworkHop,
	PreNetworkRequestEvent,
	PreNetworkResponseEvent,
} from "./cluster/cni/network";
import * as context from "./go/context";
import { getLatencyProvider, newLatencyProvider, withLatencyProvider } from "./latency";
import { browser } from "./test/describe";

browser.describe("LatencyProvider", () => {
	const chain: NetworkHop[] = [{ type: "external", host: "example.com" }];
	const requestEvent: PreNetworkRequestEvent = {
		chain,
		request: {
			method: "GET",
			url: new URL("http://example.com/"),
			header: {},
			host: "example.com",
		},
	};
	const responseEvent: PreNetworkResponseEvent = {
		...requestEvent,
		response: { status: 200, body: "" },
	};

	it("converts missing latency options to zero-returning functions", () => {
		const provider = newLatencyProvider();

		expect(provider.clusterNetworkRequestLatency(requestEvent)).toBe(0);
		expect(provider.clusterNetworkResponseLatency(responseEvent)).toBe(0);
	});

	it("passes the network event to latency option functions", () => {
		let requestLatency = 1;
		let responseLatency = 10;
		const requestEvents: PreNetworkRequestEvent[] = [];
		const responseEvents: PreNetworkResponseEvent[] = [];
		const provider = newLatencyProvider({
			clusterNetworkRequestLatency: (event) => {
				requestEvents.push(event);
				return requestLatency++;
			},
			clusterNetworkResponseLatency: (event) => {
				responseEvents.push(event);
				return (responseLatency += 5);
			},
		});

		expect(provider.clusterNetworkRequestLatency(requestEvent)).toBe(1);
		expect(provider.clusterNetworkRequestLatency(requestEvent)).toBe(2);
		expect(provider.clusterNetworkResponseLatency(responseEvent)).toBe(15);
		expect(provider.clusterNetworkResponseLatency(responseEvent)).toBe(20);
		expect(requestEvents).toEqual([requestEvent, requestEvent]);
		expect(responseEvents).toEqual([responseEvent, responseEvent]);
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

		expect(provider.clusterNetworkRequestLatency(requestEvent)).toBe(0);
		expect(provider.clusterNetworkResponseLatency(responseEvent)).toBe(0);
	});
});
