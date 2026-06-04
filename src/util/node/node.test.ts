// oxlint-disable jest/no-conditional-expect
import { expect, it } from "vitest";
import type { V1Node, V1NodeAddress } from "../../client";
import { browser } from "../../test/describe";
import { getNodeHostIPs, getPreferredNodeAddress, isNodeReady } from "./node";

// Models kubernetes/pkg/util/node/node_test.go TestGetPreferredAddress.
browser.describe("getPreferredAddress", () => {
	const testcases = new Map<
		string,
		{
			labels?: Record<string, string>;
			addresses?: V1NodeAddress[];
			preferences?: string[];
			expectErr: string;
			expectAddress: string;
		}
	>([
		[
			"no addresses",
			{
				expectErr: "no preferred addresses found; known addresses: []",
				expectAddress: "",
			},
		],
		[
			"missing address",
			{
				addresses: [{ type: "InternalIP", address: "1.2.3.4" }],
				preferences: ["Hostname"],
				expectErr: "no preferred addresses found; known addresses: [{InternalIP 1.2.3.4}]",
				expectAddress: "",
			},
		],
		[
			"found address",
			{
				addresses: [
					{ type: "InternalIP", address: "1.2.3.4" },
					{ type: "ExternalIP", address: "1.2.3.5" },
					{ type: "ExternalIP", address: "1.2.3.7" },
				],
				preferences: ["Hostname", "ExternalIP"],
				expectErr: "",
				expectAddress: "1.2.3.5",
			},
		],
		[
			"found hostname address",
			{
				labels: { "kubernetes.io/hostname": "label-hostname" },
				addresses: [
					{ type: "ExternalIP", address: "1.2.3.5" },
					{ type: "Hostname", address: "status-hostname" },
				],
				preferences: ["Hostname", "ExternalIP"],
				expectErr: "",
				expectAddress: "status-hostname",
			},
		],
		[
			"label address ignored",
			{
				labels: { "kubernetes.io/hostname": "label-hostname" },
				addresses: [{ type: "ExternalIP", address: "1.2.3.5" }],
				preferences: ["Hostname", "ExternalIP"],
				expectErr: "",
				expectAddress: "1.2.3.5",
			},
		],
	]);

	for (const [k, tc] of testcases) {
		it(k, () => {
			const node: V1Node = {
				metadata: { labels: tc.labels },
				status: { addresses: tc.addresses },
			};
			const [address, err] = getPreferredNodeAddress(node, tc.preferences ?? []);
			const errString = err?.message ?? "";

			expect(errString).toBe(tc.expectErr);
			expect(address).toBe(tc.expectAddress);
		});
	}
});

// Models kubernetes/pkg/util/node/node_test.go TestGetNodeHostIPs.
browser.describe("getNodeHostIPs", () => {
	const testcases: Array<{
		name: string;
		addresses?: V1NodeAddress[];
		expectIPs?: string[];
	}> = [
		{
			name: "no addresses",
			expectIPs: undefined,
		},
		{
			name: "no InternalIP/ExternalIP",
			addresses: [{ type: "Hostname", address: "example.com" }],
			expectIPs: undefined,
		},
		{
			name: "IPv4-only, simple",
			addresses: [
				{ type: "InternalIP", address: "1.2.3.4" },
				{ type: "ExternalIP", address: "4.3.2.1" },
				{ type: "ExternalIP", address: "4.3.2.2" },
			],
			expectIPs: ["1.2.3.4"],
		},
		{
			name: "IPv4-only, external-first",
			addresses: [
				{ type: "ExternalIP", address: "4.3.2.1" },
				{ type: "ExternalIP", address: "4.3.2.2" },
				{ type: "InternalIP", address: "1.2.3.4" },
			],
			expectIPs: ["1.2.3.4"],
		},
		{
			name: "IPv4-only, no internal",
			addresses: [
				{ type: "ExternalIP", address: "4.3.2.1" },
				{ type: "ExternalIP", address: "4.3.2.2" },
			],
			expectIPs: ["4.3.2.1"],
		},
		{
			name: "dual-stack node",
			addresses: [
				{ type: "InternalIP", address: "1.2.3.4" },
				{ type: "ExternalIP", address: "4.3.2.1" },
				{ type: "ExternalIP", address: "4.3.2.2" },
				{ type: "InternalIP", address: "a:b::c:d" },
				{ type: "ExternalIP", address: "d:c::b:a" },
			],
			expectIPs: ["1.2.3.4", "a:b::c:d"],
		},
		{
			name: "dual-stack node, different order",
			addresses: [
				{ type: "InternalIP", address: "1.2.3.4" },
				{ type: "InternalIP", address: "a:b::c:d" },
				{ type: "ExternalIP", address: "4.3.2.1" },
				{ type: "ExternalIP", address: "4.3.2.2" },
				{ type: "ExternalIP", address: "d:c::b:a" },
			],
			expectIPs: ["1.2.3.4", "a:b::c:d"],
		},
		{
			name: "dual-stack node, IPv6-first, no internal IPv4, dual-stack cluster",
			addresses: [
				{ type: "InternalIP", address: "a:b::c:d" },
				{ type: "ExternalIP", address: "d:c::b:a" },
				{ type: "ExternalIP", address: "4.3.2.1" },
				{ type: "ExternalIP", address: "4.3.2.2" },
			],
			expectIPs: ["a:b::c:d", "4.3.2.1"],
		},
	];

	it.each(testcases)("$name", (tc) => {
		const node: V1Node = {
			status: { addresses: tc.addresses },
		};
		const [nodeIPs, err] = getNodeHostIPs(node);

		if (err) {
			if (tc.expectIPs !== undefined) {
				expect.fail(`expected ${JSON.stringify(tc.expectIPs)}, got error (${err.message})`);
			}
		} else if (tc.expectIPs === undefined) {
			expect.fail(`expected error, got ${JSON.stringify(nodeIPs)}`);
		} else {
			expect(nodeIPs).toEqual(tc.expectIPs);
		}
	});
});

// Models kubernetes/pkg/util/node/node_test.go TestIsNodeReady.
browser.describe("isNodeReady", () => {
	const testCases: Array<{
		name: string;
		node: V1Node;
		expect: boolean;
	}> = [
		{
			name: "case that returns true",
			node: {
				status: {
					conditions: [
						{
							type: "Ready",
							status: "True",
						},
					],
				},
			},
			expect: true,
		},
		{
			name: "case that returns false",
			node: {
				status: {
					conditions: [
						{
							type: "Ready",
							status: "False",
						},
					],
				},
			},
			expect: false,
		},
		{
			name: "case that returns false",
			node: {
				status: {
					conditions: [
						{
							type: "MemoryPressure",
							status: "False",
						},
					],
				},
			},
			expect: false,
		},
	];

	for (const test of testCases) {
		it(test.name, () => {
			const result = isNodeReady(test.node);
			expect(result).toEqual(test.expect);
		});
	}
});
