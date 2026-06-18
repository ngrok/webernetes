import { expect, it } from "vitest";

import type {
	NetworkHop,
	PreNetworkRequestEvent,
	PreNetworkResponseEvent,
} from "./cluster/cni/network";
import type { V1Container } from "./client";
import * as context from "./go/context";
import {
	getLatencyProvider,
	newLatencyProvider,
	withLatencyProvider,
	type ContainerTerminationLatencyEvent,
} from "./latency";
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
	const container: V1Container = { name: "main", image: "busybox:1.36" };
	const containerTerminationEvent = {
		container,
	};

	it("converts missing latency options to zero-returning functions", () => {
		const provider = newLatencyProvider();

		expect(provider.clusterNetworkRequestLatency(requestEvent)).toBe(0);
		expect(provider.clusterNetworkResponseLatency(responseEvent)).toBe(0);
		expect(provider.containerTerminationLatency(containerTerminationEvent)).toBe(0);
	});

	it("passes the network event to latency option functions", () => {
		let requestLatency = 1;
		let responseLatency = 10;
		let terminationLatency = 100;
		const requestEvents: PreNetworkRequestEvent[] = [];
		const responseEvents: PreNetworkResponseEvent[] = [];
		const terminationEvents: ContainerTerminationLatencyEvent[] = [];
		const provider = newLatencyProvider({
			clusterNetworkRequestLatency: (event) => {
				requestEvents.push(event);
				return requestLatency++;
			},
			clusterNetworkResponseLatency: (event) => {
				responseEvents.push(event);
				return (responseLatency += 5);
			},
			containerTerminationLatency: (event) => {
				terminationEvents.push(event);
				return (terminationLatency += 25);
			},
		});

		expect(provider.clusterNetworkRequestLatency(requestEvent)).toBe(1);
		expect(provider.clusterNetworkRequestLatency(requestEvent)).toBe(2);
		expect(provider.clusterNetworkResponseLatency(responseEvent)).toBe(15);
		expect(provider.clusterNetworkResponseLatency(responseEvent)).toBe(20);
		expect(provider.containerTerminationLatency(containerTerminationEvent)).toBe(125);
		expect(provider.containerTerminationLatency(containerTerminationEvent)).toBe(150);
		expect(requestEvents).toEqual([requestEvent, requestEvent]);
		expect(responseEvents).toEqual([responseEvent, responseEvent]);
		expect(terminationEvents).toEqual([containerTerminationEvent, containerTerminationEvent]);
	});

	it("stores and retrieves providers through context", () => {
		const provider = newLatencyProvider({
			clusterNetworkRequestLatency: () => 12,
			clusterNetworkResponseLatency: () => 34,
			containerTerminationLatency: () => 56,
		});
		const ctx = withLatencyProvider(context.background(), provider);

		expect(getLatencyProvider(ctx)).toBe(provider);
	});

	it("falls back to the no-op provider when context has no latency provider", () => {
		const provider = getLatencyProvider(context.background());

		expect(provider.clusterNetworkRequestLatency(requestEvent)).toBe(0);
		expect(provider.clusterNetworkResponseLatency(responseEvent)).toBe(0);
		expect(provider.containerTerminationLatency(containerTerminationEvent)).toBe(0);
	});
});
