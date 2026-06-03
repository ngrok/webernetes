// oxlint-disable jest/no-standalone-expect
// oxlint-disable jest/no-conditional-expect
// oxlint-disable jest/expect-expect
import { expect, it } from "vitest";
import type { V1ObjectReference, V1Pod } from "../../../../client";
import type { DnsConfig } from "../../../cri";
import { FakeRecorder, newFakeRecorder } from "../../../../client-go/tools/record/fake";
import * as context from "../../../../go/context";
import { browser } from "../../../../test/describe";
import * as validation from "../../../apis/core/validation/validation";
import { newTestPods } from "../../kubelet-test-helpers";
import { appendDNSConfig, Configurer, getPodDNSType } from "./dns";

const testHostNameserver = "1.2.3.4";
const testHostDomain = "host.domain";

// Models kubernetes/pkg/kubelet/network/dns/dns_test.go TestFormDNSSearchFitsLimits.
browser.describe("TestFormDNSSearchFitsLimits", () => {
	const searchPathList2048Chars = [
		"A".repeat(128),
		"A".repeat(127),
		"A".repeat(127),
		"A".repeat(127),
		"A".repeat(127),
		"A".repeat(127),
		"A".repeat(127),
		"A".repeat(127),
		"A".repeat(127),
		"A".repeat(127),
		"A".repeat(127),
		"A".repeat(127),
		"A".repeat(127),
		"A".repeat(127),
		"A".repeat(127),
		"A".repeat(127),
	];

	const recorder = newFakeRecorder(20);
	const nodeRef: V1ObjectReference = {
		kind: "Node",
		name: "testNode",
		uid: "testNode",
		namespace: "",
	};
	const testClusterDNSDomain = "TEST";

	const configurer = new Configurer({
		recorder,
		nodeRef,
		clusterDomain: testClusterDNSDomain,
		resolverConfig: "",
	});

	const pod: V1Pod = {
		metadata: {
			uid: "",
			name: "test_pod",
			namespace: "testNS",
			annotations: {},
		},
		spec: {
			containers: [],
		},
	};

	const testCases: Array<{
		desc: string;
		hostNames: string[];
		resultSearch: string[];
		events: string[];
	}> = [
		{
			desc: "valid: 3 search paths",
			hostNames: ["testNS.svc.TEST", "svc.TEST", "TEST"],
			resultSearch: ["testNS.svc.TEST", "svc.TEST", "TEST"],
			events: [],
		},

		{
			desc: "valid: 5 search paths",
			hostNames: ["testNS.svc.TEST", "svc.TEST", "TEST", "AAA", "BBB"],
			resultSearch: ["testNS.svc.TEST", "svc.TEST", "TEST", "AAA", "BBB"],
			events: [],
		},

		{
			desc: "invalid: longer than 256 characters in search path list",
			hostNames: ["testNS.svc.TEST", "svc.TEST", "TEST", "AAA", "B".repeat(256), "BBB"],
			resultSearch: ["testNS.svc.TEST", "svc.TEST", "TEST", "AAA", "BBB"],
			events: [
				"Search Line limits were exceeded, some search paths have been omitted, the applied search line is: testNS.svc.TEST svc.TEST TEST AAA BBB",
			],
		},

		{
			desc: "valid: 2048 characters in search path list",
			hostNames: searchPathList2048Chars,
			resultSearch: searchPathList2048Chars,
			events: [],
		},

		{
			desc: "invalid: 2050 characters in search path list",
			hostNames: [...searchPathList2048Chars, "B"],
			resultSearch: searchPathList2048Chars,
			events: [
				`Search Line limits were exceeded, some search paths have been omitted, the applied search line is: ${searchPathList2048Chars.join(" ")}`,
			],
		},

		{
			desc: "invalid: 256 characters search path",
			hostNames: ["testNS.svc.TEST", "svc.TEST", "TEST", "AAA", "B".repeat(256), "BBB"],
			resultSearch: ["testNS.svc.TEST", "svc.TEST", "TEST", "AAA", "BBB"],
			events: [
				"Search Line limits were exceeded, some search paths have been omitted, the applied search line is: testNS.svc.TEST svc.TEST TEST AAA BBB",
			],
		},

		{
			desc: "valid: 7 search paths",
			hostNames: ["testNS.svc.TEST", "svc.TEST", "TEST", "AAA", "BBB", "CCC", "DDD"],
			resultSearch: ["testNS.svc.TEST", "svc.TEST", "TEST", "AAA", "BBB", "CCC", "DDD"],
			events: [],
		},

		{
			desc: "valid: 32 search paths",
			hostNames: [
				"testNS.svc.TEST",
				"svc.TEST",
				"TEST",
				"4",
				"5",
				"6",
				"7",
				"8",
				"9",
				"10",
				"11",
				"12",
				"13",
				"14",
				"15",
				"16",
				"17",
				"18",
				"19",
				"20",
				"21",
				"22",
				"23",
				"24",
				"25",
				"26",
				"27",
				"28",
				"29",
				"30",
				"31",
				"32",
			],
			resultSearch: [
				"testNS.svc.TEST",
				"svc.TEST",
				"TEST",
				"4",
				"5",
				"6",
				"7",
				"8",
				"9",
				"10",
				"11",
				"12",
				"13",
				"14",
				"15",
				"16",
				"17",
				"18",
				"19",
				"20",
				"21",
				"22",
				"23",
				"24",
				"25",
				"26",
				"27",
				"28",
				"29",
				"30",
				"31",
				"32",
			],
			events: [],
		},

		{
			desc: "invalid: 33 search paths",
			hostNames: [
				"testNS.svc.TEST",
				"svc.TEST",
				"TEST",
				"4",
				"5",
				"6",
				"7",
				"8",
				"9",
				"10",
				"11",
				"12",
				"13",
				"14",
				"15",
				"16",
				"17",
				"18",
				"19",
				"20",
				"21",
				"22",
				"23",
				"24",
				"25",
				"26",
				"27",
				"28",
				"29",
				"30",
				"31",
				"32",
				"33",
			],
			resultSearch: [
				"testNS.svc.TEST",
				"svc.TEST",
				"TEST",
				"4",
				"5",
				"6",
				"7",
				"8",
				"9",
				"10",
				"11",
				"12",
				"13",
				"14",
				"15",
				"16",
				"17",
				"18",
				"19",
				"20",
				"21",
				"22",
				"23",
				"24",
				"25",
				"26",
				"27",
				"28",
				"29",
				"30",
				"31",
				"32",
			],
			events: [
				"Search Line limits were exceeded, some search paths have been omitted, the applied search line is: testNS.svc.TEST svc.TEST TEST 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32",
			],
		},
	];

	for (const [i, tc] of testCases.entries()) {
		it(tc.desc, async () => {
			const dnsSearch = await configurer.formDNSSearchFitsLimits(tc.hostNames, pod);
			expect(dnsSearch).toEqual(tc.resultSearch);
			for (const expectedEvent of tc.events) {
				const expected = `Warning DNSConfigForming ${expectedEvent}`;
				const event = fetchEvent(recorder);
				expect({ event, i }).toEqual({ event: expected, i });
			}
		});
	}
});

// Models kubernetes/pkg/kubelet/network/dns/dns_test.go TestFormDNSNameserversFitsLimits.
browser.describe("TestFormDNSNameserversFitsLimits", () => {
	const recorder = newFakeRecorder(20);
	const nodeRef: V1ObjectReference = {
		kind: "Node",
		name: "testNode",
		uid: "testNode",
		namespace: "",
	};
	const testClusterDNSDomain = "TEST";

	const configurer = new Configurer({
		recorder,
		nodeRef,
		clusterDomain: testClusterDNSDomain,
		resolverConfig: "",
	});

	const pod: V1Pod = {
		metadata: {
			uid: "",
			name: "test_pod",
			namespace: "testNS",
			annotations: {},
		},
		spec: {
			containers: [],
		},
	};

	const testCases: Array<{
		desc: string;
		nameservers: string[];
		expectedNameserver: string[];
		expectedEvent: boolean;
	}> = [
		{
			desc: "valid: 1 nameserver",
			nameservers: ["127.0.0.1"],
			expectedNameserver: ["127.0.0.1"],
			expectedEvent: false,
		},
		{
			desc: "valid: 3 nameservers",
			nameservers: ["127.0.0.1", "10.0.0.10", "8.8.8.8"],
			expectedNameserver: ["127.0.0.1", "10.0.0.10", "8.8.8.8"],
			expectedEvent: false,
		},
		{
			desc: "invalid: 4 nameservers, trimmed to 3",
			nameservers: ["127.0.0.1", "10.0.0.10", "8.8.8.8", "1.2.3.4"],
			expectedNameserver: ["127.0.0.1", "10.0.0.10", "8.8.8.8"],
			expectedEvent: true,
		},
	];

	for (const tc of testCases) {
		it(tc.desc, async () => {
			const appliedNameservers = await configurer.formDNSNameserversFitsLimits(tc.nameservers, pod);
			expect(appliedNameservers).toEqual(tc.expectedNameserver);
			const event = fetchEvent(recorder);
			if (tc.expectedEvent && event.length === 0) {
				throw new Error(
					`${tc.desc}: formDNSNameserversFitsLimits(${tc.nameservers.join(",")}) expected event, got no event.`,
				);
			} else if (!tc.expectedEvent && event.length > 0) {
				throw new Error(
					`${tc.desc}: formDNSNameserversFitsLimits(${tc.nameservers.join(",")}) expected no event, got event: ${event}`,
				);
			}
		});
	}
});

// Models kubernetes/pkg/kubelet/network/dns/dns_test.go TestMergeDNSOptions.
browser.describe("TestMergeDNSOptions", () => {
	const testOptionValue = "3";

	const testCases: Array<{
		desc: string;
		existingDNSConfigOptions: string[];
		dnsConfigOptions: NonNullable<NonNullable<V1Pod["spec"]>["dnsConfig"]>["options"];
		expectedOptions: string[];
	}> = [
		{
			desc: "Empty dnsConfigOptions",
			existingDNSConfigOptions: ["ndots:5", "debug"],
			dnsConfigOptions: undefined,
			expectedOptions: ["ndots:5", "debug"],
		},
		{
			desc: "No duplicated entries",
			existingDNSConfigOptions: ["ndots:5", "debug"],
			dnsConfigOptions: [{ name: "single-request" }, { name: "attempts", value: testOptionValue }],
			expectedOptions: ["ndots:5", "debug", "single-request", "attempts:3"],
		},
		{
			desc: "Overwrite duplicated entries",
			existingDNSConfigOptions: ["ndots:5", "debug"],
			dnsConfigOptions: [
				{ name: "ndots", value: testOptionValue },
				{ name: "debug" },
				{ name: "single-request" },
				{ name: "attempts", value: testOptionValue },
			],
			expectedOptions: ["ndots:3", "debug", "single-request", "attempts:3"],
		},
	];

	for (const tc of testCases) {
		it(tc.desc, () => {
			const dnsConfig = appendDNSConfig(
				{ servers: [], searches: [], options: [...tc.existingDNSConfigOptions] },
				{ options: tc.dnsConfigOptions },
			);
			expect(setEquals(new Set(dnsConfig.options), new Set(tc.expectedOptions))).toBe(true);
		});
	}
});

// Models kubernetes/pkg/kubelet/network/dns/dns_test.go TestGetPodDNSType.
browser.describe("TestGetPodDNSType", () => {
	const recorder = newFakeRecorder(20);
	const nodeRef: V1ObjectReference = {
		kind: "Node",
		name: "testNode",
		uid: "testNode",
		namespace: "",
	};
	const testClusterDNSDomain = "TEST";
	const clusterNS = "203.0.113.1";
	const testClusterDNS = [clusterNS];

	const configurer = new Configurer({
		recorder,
		nodeRef,
		clusterDomain: testClusterDNSDomain,
		resolverConfig: "",
	});

	const pod: V1Pod = {
		metadata: {
			uid: "",
			name: "test_pod",
			namespace: "testNS",
			annotations: {},
		},
		spec: {
			containers: [],
		},
	};

	const testCases: Array<{
		desc: string;
		hasClusterDNS?: boolean;
		hostNetwork?: boolean;
		dnsPolicy: string;
		expectedDNSType?: string;
		expectedError?: boolean;
	}> = [
		{
			desc: "valid DNSClusterFirst without hostnetwork",
			hasClusterDNS: true,
			dnsPolicy: "ClusterFirst",
			expectedDNSType: "cluster",
		},
		{
			desc: "valid DNSClusterFirstWithHostNet with hostnetwork",
			hasClusterDNS: true,
			hostNetwork: true,
			dnsPolicy: "ClusterFirstWithHostNet",
			expectedDNSType: "cluster",
		},
		{
			desc: "valid DNSClusterFirstWithHostNet without hostnetwork",
			hasClusterDNS: true,
			dnsPolicy: "ClusterFirstWithHostNet",
			expectedDNSType: "cluster",
		},
		{
			desc: "valid DNSDefault without hostnetwork",
			dnsPolicy: "Default",
			expectedDNSType: "host",
		},
		{
			desc: "valid DNSDefault with hostnetwork",
			hostNetwork: true,
			dnsPolicy: "Default",
			expectedDNSType: "host",
		},
		{
			desc: "DNSClusterFirst with hostnetwork, fallback to DNSDefault",
			hasClusterDNS: true,
			hostNetwork: true,
			dnsPolicy: "ClusterFirst",
			expectedDNSType: "host",
		},
		{
			desc: "valid DNSNone",
			dnsPolicy: "None",
			expectedDNSType: "none",
		},
		{
			desc: "invalid DNS policy, should return error",
			dnsPolicy: "invalidPolicy",
			expectedError: true,
		},
	];

	for (const tc of testCases) {
		it(tc.desc, () => {
			if (tc.hasClusterDNS) {
				configurer.clusterDNS = testClusterDNS;
			} else {
				configurer.clusterDNS = [];
			}
			pod.spec = {
				containers: [],
				dnsPolicy: tc.dnsPolicy,
				hostNetwork: tc.hostNetwork,
			};

			const [resType, err] = getPodDNSType(pod);
			if (tc.expectedError) {
				if (err === undefined) {
					throw new Error(
						`${tc.desc}: GetPodDNSType(${JSON.stringify(pod)}) got no error, want error`,
					);
				}
				return;
			}
			if (resType !== tc.expectedDNSType) {
				throw new Error(
					`${tc.desc}: GetPodDNSType(${JSON.stringify(pod)})=${resType}, want ${tc.expectedDNSType}`,
				);
			}
		});
	}
});

// Models kubernetes/pkg/kubelet/network/dns/dns_test.go TestGetPodDNS.
browser.describe("TestGetPodDNS", () => {
	it("generates pod DNS config", async () => {
		const recorder = newFakeRecorder(20);
		const nodeRef: V1ObjectReference = {
			kind: "Node",
			name: "testNode",
			uid: "testNode",
			namespace: "",
		};
		const clusterNS = "203.0.113.1";
		const testClusterDNSDomain = "kubernetes.io";
		const testClusterDNS = [clusterNS];

		let configurer = new Configurer({
			recorder,
			nodeRef,
			clusterDNS: testClusterDNS,
			clusterDomain: testClusterDNSDomain,
			resolverConfig: "",
		});

		const pods = newTestPods(4);
		pods[0].spec = { ...pods[0].spec, containers: [], dnsPolicy: "ClusterFirstWithHostNet" };
		pods[1].spec = { ...pods[1].spec, containers: [], dnsPolicy: "ClusterFirst" };
		pods[2].spec = {
			...pods[2].spec,
			containers: [],
			dnsPolicy: "ClusterFirst",
			hostNetwork: false,
		};
		pods[3].spec = { ...pods[3].spec, containers: [], dnsPolicy: "Default" };

		const options: Array<{
			DNS: string[];
			DNSSearch: string[];
		}> = new Array(4);
		for (const [i, pod] of pods.entries()) {
			let err: Error | undefined;
			const [dnsConfig, dnsErr] = await configurer.getPodDNS(context.background(), pod);
			err = dnsErr;
			if (err !== undefined) {
				throw new Error(`failed to generate container options: ${err.message}`);
			}
			options[i] = {
				DNS: dnsConfig?.servers ?? [],
				DNSSearch: dnsConfig?.searches ?? [],
			};
		}
		if (options[0].DNS.length !== 1 || options[0].DNS[0] !== clusterNS) {
			throw new Error(`expected nameserver ${clusterNS}, got ${JSON.stringify(options[0].DNS)}`);
		}
		if (
			options[0].DNSSearch.length === 0 ||
			options[0].DNSSearch[0] !== `.svc.${configurer.clusterDomain}`
		) {
			throw new Error(
				`expected search .svc.${configurer.clusterDomain}, got ${JSON.stringify(options[0].DNSSearch)}`,
			);
		}
		if (options[1].DNS.length !== 1 || options[1].DNS[0] !== "127.0.0.1") {
			throw new Error(`expected nameserver 127.0.0.1, got ${JSON.stringify(options[1].DNS)}`);
		}
		if (options[1].DNSSearch.length !== 1 || options[1].DNSSearch[0] !== ".") {
			throw new Error(`expected search ".", got ${JSON.stringify(options[1].DNSSearch)}`);
		}
		if (options[2].DNS.length !== 1 || options[2].DNS[0] !== clusterNS) {
			throw new Error(`expected nameserver ${clusterNS}, got ${JSON.stringify(options[2].DNS)}`);
		}
		if (
			options[2].DNSSearch.length === 0 ||
			options[2].DNSSearch[0] !== `.svc.${configurer.clusterDomain}`
		) {
			throw new Error(
				`expected search .svc.${configurer.clusterDomain}, got ${JSON.stringify(options[2].DNSSearch)}`,
			);
		}
		if (options[3].DNS.length !== 1 || options[3].DNS[0] !== "127.0.0.1") {
			throw new Error(`expected nameserver 127.0.0.1, got ${JSON.stringify(options[3].DNS)}`);
		}
		if (options[3].DNSSearch.length !== 1 || options[3].DNSSearch[0] !== ".") {
			throw new Error(`expected search ".", got ${JSON.stringify(options[3].DNSSearch)}`);
		}

		configurer = new Configurer({
			recorder,
			nodeRef,
			clusterDNS: testClusterDNS,
			clusterDomain: testClusterDNSDomain,
			resolverConfig: "default",
			getHostDNSConfig: fakeGetHostDNSConfigCustom,
		});

		for (const [i, pod] of pods.entries()) {
			let err: Error | undefined;
			const [dnsConfig, dnsErr] = await configurer.getPodDNS(context.background(), pod);
			err = dnsErr;
			if (err !== undefined) {
				throw new Error(`failed to generate container options: ${err.message}`);
			}
			options[i] = {
				DNS: dnsConfig?.servers ?? [],
				DNSSearch: dnsConfig?.searches ?? [],
			};
		}
		if (options[0].DNS.length !== 1) {
			throw new Error(`expected cluster nameserver only, got ${JSON.stringify(options[0].DNS)}`);
		} else if (options[0].DNS[0] !== clusterNS) {
			throw new Error(`expected nameserver ${clusterNS}, got ${options[0].DNS[0]}`);
		}
		let expLength = options[1].DNSSearch.length + 3;

		const maxDNSSearchPaths = validation.maxDNSSearchPaths;

		if (expLength > maxDNSSearchPaths) {
			expLength = maxDNSSearchPaths;
		}
		if (options[0].DNSSearch.length !== expLength) {
			throw new Error(
				`expected prepend of cluster domain, got ${JSON.stringify(options[0].DNSSearch)}`,
			);
		} else if (options[0].DNSSearch[0] !== `.svc.${configurer.clusterDomain}`) {
			throw new Error(
				`expected domain .svc.${configurer.clusterDomain}, got ${options[0].DNSSearch}`,
			);
		}
		if (options[2].DNS.length !== 1) {
			throw new Error(`expected cluster nameserver only, got ${JSON.stringify(options[2].DNS)}`);
		} else if (options[2].DNS[0] !== clusterNS) {
			throw new Error(`expected nameserver ${clusterNS}, got ${options[2].DNS[0]}`);
		}
		if (options[2].DNSSearch.length !== expLength) {
			throw new Error(
				`expected prepend of cluster domain, got ${JSON.stringify(options[2].DNSSearch)}`,
			);
		} else if (options[2].DNSSearch[0] !== `.svc.${configurer.clusterDomain}`) {
			throw new Error(
				`expected domain .svc.${configurer.clusterDomain}, got ${options[0].DNSSearch}`,
			);
		}
	});
});

// Models kubernetes/pkg/kubelet/network/dns/dns_test.go TestGetPodDNSCustom.
browser.describe("TestGetPodDNSCustom", () => {
	const recorder = newFakeRecorder(20);
	const nodeRef: V1ObjectReference = {
		kind: "Node",
		name: "testNode",
		uid: "testNode",
		namespace: "",
	};

	const testPodNamespace = "testNS";
	const testClusterNameserver = "10.0.0.10";
	const testClusterDNSDomain = "kubernetes.io";
	const testSvcDomain = `svc.${testClusterDNSDomain}`;
	const testNsSvcDomain = `${testPodNamespace}.svc.${testClusterDNSDomain}`;
	const testNdotsOptionValue = "3";

	const testPod: V1Pod = {
		metadata: {
			name: "test_pod",
			namespace: testPodNamespace,
		},
		spec: {
			containers: [],
		},
	};

	const configurer = new Configurer({
		recorder,
		nodeRef,
		clusterDNS: [testClusterNameserver],
		clusterDomain: testClusterDNSDomain,
		resolverConfig: "injected",
		getHostDNSConfig: () => [
			{
				servers: [testHostNameserver],
				searches: [testHostDomain],
				options: [],
			},
			undefined,
		],
	});

	const testCases: Array<{
		desc: string;
		hostnetwork?: boolean;
		dnsPolicy: string;
		dnsConfig?: NonNullable<NonNullable<V1Pod["spec"]>["dnsConfig"]>;
		expectedDNSConfig: DnsConfig;
	}> = [
		{
			desc: "DNSNone without DNSConfig should have empty DNS settings",
			dnsPolicy: "None",
			expectedDNSConfig: { servers: [], searches: [], options: [] },
		},
		{
			desc: "DNSNone with DNSConfig should have a merged DNS settings",
			dnsPolicy: "None",
			dnsConfig: {
				nameservers: ["203.0.113.1"],
				searches: ["my.domain", "second.domain"],
				options: [{ name: "ndots", value: testNdotsOptionValue }, { name: "debug" }],
			},
			expectedDNSConfig: {
				servers: ["203.0.113.1"],
				searches: ["my.domain", "second.domain"],
				options: ["ndots:3", "debug"],
			},
		},
		{
			desc: "DNSClusterFirst with DNSConfig should have a merged DNS settings",
			dnsPolicy: "ClusterFirst",
			dnsConfig: {
				nameservers: ["10.0.0.11"],
				searches: ["my.domain"],
				options: [{ name: "ndots", value: testNdotsOptionValue }, { name: "debug" }],
			},
			expectedDNSConfig: {
				servers: [testClusterNameserver, "10.0.0.11"],
				searches: [
					testNsSvcDomain,
					testSvcDomain,
					testClusterDNSDomain,
					testHostDomain,
					"my.domain",
				],
				options: ["ndots:3", "debug"],
			},
		},
		{
			desc: "DNSClusterFirstWithHostNet with DNSConfig should have a merged DNS settings",
			hostnetwork: true,
			dnsPolicy: "ClusterFirstWithHostNet",
			dnsConfig: {
				nameservers: ["10.0.0.11"],
				searches: ["my.domain"],
				options: [{ name: "ndots", value: testNdotsOptionValue }, { name: "debug" }],
			},
			expectedDNSConfig: {
				servers: [testClusterNameserver, "10.0.0.11"],
				searches: [
					testNsSvcDomain,
					testSvcDomain,
					testClusterDNSDomain,
					testHostDomain,
					"my.domain",
				],
				options: ["ndots:3", "debug"],
			},
		},
		{
			desc: "DNSDefault with DNSConfig should have a merged DNS settings",
			dnsPolicy: "Default",
			dnsConfig: {
				nameservers: ["10.0.0.11"],
				searches: ["my.domain"],
				options: [{ name: "ndots", value: testNdotsOptionValue }, { name: "debug" }],
			},
			expectedDNSConfig: {
				servers: [testHostNameserver, "10.0.0.11"],
				searches: [testHostDomain, "my.domain"],
				options: ["ndots:3", "debug"],
			},
		},
	];

	for (const tc of testCases) {
		it(tc.desc, async () => {
			testPod.spec = {
				containers: [],
				hostNetwork: tc.hostnetwork,
				dnsConfig: tc.dnsConfig,
				dnsPolicy: tc.dnsPolicy,
			};

			const [resDNSConfig, err] = await configurer.getPodDNS(context.background(), testPod);
			if (err !== undefined) {
				throw new Error(
					`${tc.desc}: GetPodDNS(${JSON.stringify(testPod)}), unexpected error: ${err.message}`,
				);
			}
			if (!dnsConfigsAreEqual(resDNSConfig, tc.expectedDNSConfig)) {
				throw new Error(
					`${tc.desc}: GetPodDNS(${JSON.stringify(testPod)})=${JSON.stringify(resDNSConfig)}, want ${JSON.stringify(tc.expectedDNSConfig)}`,
				);
			}
		});
	}
});

browser.describe("GetPodDNS local event coverage", () => {
	it("returns host DNS config errors", async () => {
		const recorder = newFakeRecorder(20);
		const hostDNSErr = new Error("host dns config failed");
		const configurer = newConfigurer(recorder, {
			resolverConfig: "broken",
			getHostDNSConfig: () => [undefined, hostDNSErr],
		});
		const pod = testPod();

		const [dnsConfig, err] = await configurer.getPodDNS(context.background(), pod);

		expect(dnsConfig).toBeUndefined();
		expect(err).toBe(hostDNSErr);
	});

	it("falls back for invalid DNS policy without recording an invalid-policy warning", async () => {
		const recorder = newFakeRecorder(20);
		const configurer = newConfigurer(recorder, {
			clusterDNS: ["203.0.113.1"],
			clusterDomain: "kubernetes.io",
			resolverConfig: "",
		});
		const pod = testPod();
		pod.spec = {
			containers: [],
			dnsPolicy: "invalidPolicy",
		};

		const [dnsConfig, err] = await configurer.getPodDNS(context.background(), pod);

		expect(err).toBeUndefined();
		expect(dnsConfig).toEqual({
			servers: ["203.0.113.1"],
			searches: ["testNS.svc.kubernetes.io", "svc.kubernetes.io", "kubernetes.io"],
			options: ["ndots:5"],
		});
		expect(recorder.events?.tryReceive()).toBeUndefined();
	});

	it("records MissingClusterDNS warnings and falls back to host DNS", async () => {
		const recorder = newFakeRecorder(20);
		recorder.includeObject = true;
		const configurer = newConfigurer(recorder, {
			clusterDNS: [],
			clusterDomain: "kubernetes.io",
			nodeIPs: ["127.0.0.1"],
			resolverConfig: "",
		});
		const pod = testPod();
		pod.spec = {
			containers: [],
			dnsPolicy: "ClusterFirst",
		};

		const [dnsConfig, err] = await configurer.getPodDNS(context.background(), pod);

		expect(err).toBeUndefined();
		expect(dnsConfig).toEqual({
			servers: ["127.0.0.1"],
			searches: ["."],
			options: [],
		});
		expect(fetchEvent(recorder)).toContain(
			"Warning MissingClusterDNS kubelet does not have ClusterDNS IP configured",
		);
		expect(fetchEvent(recorder)).toContain(
			'Warning MissingClusterDNS pod: "testNS/test_pod ()". kubelet does not have ClusterDNS IP configured',
		);
	});
});

function fakeGetHostDNSConfigCustom(): [dnsConfig: DnsConfig, err: undefined] {
	return [
		{
			servers: [testHostNameserver],
			searches: [testHostDomain],
			options: [],
		},
		undefined,
	];
}

function dnsConfigsAreEqual(resConfig: DnsConfig | undefined, expectedConfig: DnsConfig): boolean {
	if (
		!resConfig ||
		resConfig.servers.length !== expectedConfig.servers.length ||
		resConfig.searches.length !== expectedConfig.searches.length ||
		resConfig.options.length !== expectedConfig.options.length
	) {
		return false;
	}
	for (const [i, server] of resConfig.servers.entries()) {
		if (expectedConfig.servers[i] !== server) {
			return false;
		}
	}
	for (const [i, search] of resConfig.searches.entries()) {
		if (expectedConfig.searches[i] !== search) {
			return false;
		}
	}
	return setEquals(new Set(resConfig.options), new Set(expectedConfig.options));
}

function testPod(): V1Pod {
	return {
		metadata: {
			uid: "",
			name: "test_pod",
			namespace: "testNS",
			annotations: {},
		},
		spec: {
			containers: [],
		},
	};
}

function newConfigurer(
	recorder: FakeRecorder,
	options: Partial<ConstructorParameters<typeof Configurer>[0]> = {},
): Configurer {
	return new Configurer({
		recorder,
		nodeRef: {
			kind: "Node",
			name: "testNode",
			uid: "testNode",
			namespace: "",
		},
		clusterDomain: "",
		resolverConfig: "",
		...options,
	});
}

function fetchEvent(recorder: FakeRecorder): string {
	const event = recorder.events?.tryReceive();
	if (!event?.ok) {
		return "";
	}
	return event.value;
}

function setEquals<T>(left: Set<T>, right: Set<T>): boolean {
	if (left.size !== right.size) {
		return false;
	}
	for (const value of left) {
		if (!right.has(value)) {
			return false;
		}
	}
	return true;
}
