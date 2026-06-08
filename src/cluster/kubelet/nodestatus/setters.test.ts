// oxlint-disable jest/no-conditional-expect
import { expect, it } from "vitest";
import type { V1Node, V1NodeAddress } from "../../../client";
import * as context from "../../../go/context";
import { browser } from "../../../test/describe";
import { FakeVersion } from "../container/testing";
import { RuntimeFeatures, RuntimeHandler, type Image } from "../container";
import {
	daemonEndpoints,
	goRuntime,
	images,
	kubeletVersion,
	maxNamesPerImageInNodeStatus,
	nodeAddress,
	nodeFeatures,
	runtimeHandlers,
	versionInfo,
	type CadvisorVersionInfo,
} from "./setters";

const testKubeletHostname = "test-hostname";
const annotationAlphaProvidedIPAddr = "alpha.kubernetes.io/provided-node-ip";

// Models kubernetes/pkg/kubelet/nodestatus/setters_test.go TestNodeAddress.
browser.describe("NodeAddress", () => {
	const existingNodeAddress: V1NodeAddress = { address: "10.1.1.2", type: "" };
	const cases: Array<{
		name: string;
		nodeIP?: string;
		secondaryNodeIP?: string;
		resolvedIP?: string;
		cloudProvider: boolean;
		expectedAddresses: V1NodeAddress[];
		existingAnnotations?: Record<string, string>;
		expectedAnnotations?: Record<string, string>;
		shouldError?: boolean;
		shouldSetNodeAddressBeforeTest?: boolean;
	}> = [
		{
			name: "using cloud provider and nodeIP specified",
			nodeIP: "10.0.0.1",
			cloudProvider: true,
			expectedAddresses: [
				{ type: "InternalIP", address: "10.0.0.1" },
				{ type: "Hostname", address: testKubeletHostname },
			],
			shouldError: false,
		},
		{
			name: "no cloud provider and nodeIP IPv4 unspecified",
			nodeIP: "0.0.0.0",
			resolvedIP: "10.0.0.2",
			cloudProvider: false,
			expectedAddresses: [
				{ type: "InternalIP", address: "10.0.0.2" },
				{ type: "Hostname", address: testKubeletHostname },
			],
			shouldError: false,
		},
		{
			name: "no cloud provider and nodeIP IPv6 unspecified",
			nodeIP: "::",
			resolvedIP: "2001:db2::2",
			cloudProvider: false,
			expectedAddresses: [
				{ type: "InternalIP", address: "2001:db2::2" },
				{ type: "Hostname", address: testKubeletHostname },
			],
			shouldError: false,
		},
		{
			name: "using cloud provider and nodeIP IPv4 unspecified",
			nodeIP: "0.0.0.0",
			resolvedIP: "10.0.0.2",
			cloudProvider: true,
			expectedAddresses: [
				{ type: "InternalIP", address: "10.0.0.2" },
				{ type: "Hostname", address: testKubeletHostname },
			],
			shouldError: false,
		},
		{
			name: "using cloud provider and nodeIP IPv6 unspecified",
			nodeIP: "::",
			resolvedIP: "2001:db2::2",
			cloudProvider: true,
			expectedAddresses: [
				{ type: "InternalIP", address: "2001:db2::2" },
				{ type: "Hostname", address: testKubeletHostname },
			],
			shouldError: false,
		},
		{
			name: "no cloud provider and no nodeIP resolve IPv4",
			resolvedIP: "10.0.0.2",
			cloudProvider: false,
			expectedAddresses: [
				{ type: "InternalIP", address: "10.0.0.2" },
				{ type: "Hostname", address: testKubeletHostname },
			],
			shouldError: false,
		},
		{
			name: "no cloud provider and no nodeIP resolve IPv6",
			resolvedIP: "2001:db2::2",
			cloudProvider: false,
			expectedAddresses: [
				{ type: "InternalIP", address: "2001:db2::2" },
				{ type: "Hostname", address: testKubeletHostname },
			],
			shouldError: false,
		},
		{
			name: "using cloud provider and no nodeIP resolve IPv4",
			resolvedIP: "10.0.0.2",
			cloudProvider: true,
			expectedAddresses: [{ type: "Hostname", address: testKubeletHostname }],
			shouldError: false,
		},
		{
			name: "using cloud provider and no nodeIP resolve IPv6",
			resolvedIP: "2001:db2::2",
			cloudProvider: true,
			expectedAddresses: [{ type: "Hostname", address: testKubeletHostname }],
			shouldError: false,
		},
		{
			name: "cloud provider gets nodeIP annotation",
			nodeIP: "10.1.1.1",
			cloudProvider: true,
			expectedAddresses: [
				{ type: "InternalIP", address: "10.1.1.1" },
				{ type: "Hostname", address: testKubeletHostname },
			],
			expectedAnnotations: {
				[annotationAlphaProvidedIPAddr]: "10.1.1.1",
			},
			shouldError: false,
		},
		{
			name: "using cloud provider and node address is already set",
			nodeIP: "10.1.1.1",
			cloudProvider: true,
			expectedAddresses: [existingNodeAddress],
			shouldError: true,
			shouldSetNodeAddressBeforeTest: true,
		},
		{
			name: "No cloud provider does not get nodeIP annotation",
			nodeIP: "10.1.1.1",
			cloudProvider: false,
			expectedAddresses: [
				{ type: "InternalIP", address: "10.1.1.1" },
				{ type: "Hostname", address: testKubeletHostname },
			],
			expectedAnnotations: {},
			shouldError: false,
		},
		{
			name: "Stale nodeIP annotation is removed when not using cloud provider",
			nodeIP: "10.1.1.1",
			cloudProvider: false,
			expectedAddresses: [
				{ type: "InternalIP", address: "10.1.1.1" },
				{ type: "Hostname", address: testKubeletHostname },
			],
			existingAnnotations: {
				[annotationAlphaProvidedIPAddr]: "10.1.1.3",
			},
			expectedAnnotations: {},
			shouldError: false,
		},
		{
			name: "Incorrect nodeIP annotation is fixed",
			nodeIP: "10.1.1.1",
			cloudProvider: true,
			expectedAddresses: [
				{ type: "InternalIP", address: "10.1.1.1" },
				{ type: "Hostname", address: testKubeletHostname },
			],
			existingAnnotations: {
				[annotationAlphaProvidedIPAddr]: "10.1.1.3",
			},
			expectedAnnotations: {
				[annotationAlphaProvidedIPAddr]: "10.1.1.1",
			},
			shouldError: false,
		},
		{
			name: "Dual-stack cloud, with dual-stack nodeIPs",
			nodeIP: "2600:1f14:1d4:d101::ba3d",
			secondaryNodeIP: "10.1.1.2",
			cloudProvider: true,
			expectedAddresses: [
				{ type: "InternalIP", address: "2600:1f14:1d4:d101::ba3d" },
				{ type: "InternalIP", address: "10.1.1.2" },
				{ type: "Hostname", address: testKubeletHostname },
			],
			expectedAnnotations: {
				[annotationAlphaProvidedIPAddr]: "2600:1f14:1d4:d101::ba3d,10.1.1.2",
			},
			shouldError: false,
		},
		{
			name: "Upgrade to cloud dual-stack nodeIPs",
			nodeIP: "10.1.1.1",
			secondaryNodeIP: "2600:1f14:1d4:d101::ba3d",
			cloudProvider: true,
			expectedAddresses: [
				{ type: "InternalIP", address: "10.1.1.1" },
				{ type: "InternalIP", address: "2600:1f14:1d4:d101::ba3d" },
				{ type: "Hostname", address: testKubeletHostname },
			],
			existingAnnotations: {
				[annotationAlphaProvidedIPAddr]: "10.1.1.1",
			},
			expectedAnnotations: {
				[annotationAlphaProvidedIPAddr]: "10.1.1.1,2600:1f14:1d4:d101::ba3d",
			},
			shouldError: false,
		},
		{
			name: "Downgrade from cloud dual-stack nodeIPs",
			nodeIP: "10.1.1.1",
			cloudProvider: true,
			expectedAddresses: [
				{ type: "InternalIP", address: "10.1.1.1" },
				{ type: "Hostname", address: testKubeletHostname },
			],
			existingAnnotations: {
				[annotationAlphaProvidedIPAddr]: "10.1.1.1,2600:1f14:1d4:d101::ba3d",
			},
			expectedAnnotations: {
				[annotationAlphaProvidedIPAddr]: "10.1.1.1",
			},
			shouldError: false,
		},
	];

	for (const testCase of cases) {
		it(testCase.name, async () => {
			const existingNode: V1Node = {
				metadata: {
					name: testKubeletHostname,
					annotations: testCase.existingAnnotations,
				},
				spec: {},
				status: {
					addresses: [],
				},
			};

			if (testCase.shouldSetNodeAddressBeforeTest) {
				existingNode.status?.addresses?.push(existingNodeAddress);
			}

			const nodeIPs = testCase.nodeIP === undefined ? [] : [testCase.nodeIP];
			if (testCase.secondaryNodeIP) {
				nodeIPs.push(testCase.secondaryNodeIP);
			}
			const setter = nodeAddress(
				nodeIPs,
				(_nodeIP) => undefined,
				testKubeletHostname,
				testCase.cloudProvider,
				() => [testCase.resolvedIP, undefined],
			);

			const err = await setter(context.background(), existingNode);

			if (err && !testCase.shouldError) {
				throw err;
			} else if (err && testCase.shouldError) {
				return;
			}
			expect(err).toBeUndefined();
			expect(existingNode.status?.addresses).toEqual(testCase.expectedAddresses);
			if (testCase.expectedAnnotations) {
				expect(existingNode.metadata?.annotations ?? {}).toEqual(testCase.expectedAnnotations);
			}
		});
	}
});

// Models kubernetes/pkg/kubelet/nodestatus/setters_test.go TestNodeAddress_NoCloudProvider.
browser.describe("NodeAddress_NoCloudProvider", () => {
	const cases: Array<{
		name: string;
		nodeIPs: string[];
		expectedAddresses: V1NodeAddress[];
		shouldError?: boolean;
	}> = [
		{
			name: "Single --node-ip",
			nodeIPs: ["10.1.1.1"],
			expectedAddresses: [
				{ type: "InternalIP", address: "10.1.1.1" },
				{ type: "Hostname", address: testKubeletHostname },
			],
		},
		{
			name: "Invalid single --node-ip (using loopback)",
			nodeIPs: ["127.0.0.1"],
			expectedAddresses: [],
			shouldError: true,
		},
		{
			name: "Dual --node-ips",
			nodeIPs: ["10.1.1.1", "fd01::1234"],
			expectedAddresses: [
				{ type: "InternalIP", address: "10.1.1.1" },
				{ type: "InternalIP", address: "fd01::1234" },
				{ type: "Hostname", address: testKubeletHostname },
			],
		},
		{
			name: "Dual --node-ips but with invalid secondary IP (using multicast IP)",
			nodeIPs: ["10.1.1.1", "224.0.0.0"],
			expectedAddresses: [],
			shouldError: true,
		},
	];

	for (const testCase of cases) {
		it(testCase.name, async () => {
			const existingNode: V1Node = {
				metadata: { name: testKubeletHostname, annotations: {} },
				spec: {},
				status: { addresses: [] },
			};
			const setter = nodeAddress(
				testCase.nodeIPs,
				(nodeIP) => {
					if (nodeIP === "127.0.0.1") {
						return new Error("nodeIP can't be loopback address");
					}
					if (nodeIP === "224.0.0.0") {
						return new Error("nodeIP can't be a multicast address");
					}
					return undefined;
				},
				testKubeletHostname,
				false,
				() => [undefined, new Error("not reached")],
			);

			const err = await setter(context.background(), existingNode);

			if (testCase.shouldError) {
				expect(err).toBeDefined();
				return;
			}
			expect(err).toBeUndefined();
			expect(existingNode.status?.addresses).toEqual(testCase.expectedAddresses);
		});
	}
});

// Models kubernetes/pkg/kubelet/nodestatus/setters_test.go TestVersionInfo.
browser.describe("VersionInfo", () => {
	const cases: Array<{
		desc: string;
		node: V1Node;
		versionInfo?: CadvisorVersionInfo;
		versionInfoError?: Error;
		runtimeType?: string;
		runtimeVersion?: FakeVersion;
		runtimeVersionError?: Error;
		expectNode: V1Node;
		expectError?: Error;
	}> = [
		{
			desc: "versions set in node info",
			node: {},
			versionInfo: {
				kernelVersion: "KernelVersion",
				containerOsVersion: "ContainerOSVersion",
			},
			runtimeType: "RuntimeType",
			runtimeVersion: new FakeVersion("RuntimeVersion"),
			expectNode: {
				status: {
					nodeInfo: {
						architecture: "",
						bootID: "",
						containerRuntimeVersion: "RuntimeType://RuntimeVersion",
						kernelVersion: "KernelVersion",
						kubeProxyVersion: "",
						kubeletVersion,
						machineID: "",
						operatingSystem: "",
						osImage: "ContainerOSVersion",
						systemUUID: "",
					},
				},
			},
		},
		{
			desc: "error getting version info",
			node: {},
			versionInfoError: new Error("foo"),
			expectNode: {},
			expectError: new Error("error getting version info: foo"),
		},
		{
			desc: "error getting runtime version results in Unknown runtime",
			node: {},
			versionInfo: {
				kernelVersion: "",
				containerOsVersion: "",
			},
			runtimeType: "RuntimeType",
			runtimeVersionError: new Error("foo"),
			expectNode: {
				status: {
					nodeInfo: {
						architecture: "",
						bootID: "",
						containerRuntimeVersion: "RuntimeType://Unknown",
						kernelVersion: "",
						kubeProxyVersion: "",
						kubeletVersion,
						machineID: "",
						operatingSystem: "",
						osImage: "",
						systemUUID: "",
					},
				},
			},
		},
		{
			desc: "DisableNodeKubeProxyVersion FeatureGate enable, versions set in node info",
			node: {},
			versionInfo: {
				kernelVersion: "KernelVersion",
				containerOsVersion: "ContainerOSVersion",
			},
			runtimeType: "RuntimeType",
			runtimeVersion: new FakeVersion("RuntimeVersion"),
			expectNode: {
				status: {
					nodeInfo: {
						architecture: "",
						bootID: "",
						containerRuntimeVersion: "RuntimeType://RuntimeVersion",
						kernelVersion: "KernelVersion",
						kubeProxyVersion: "",
						kubeletVersion,
						machineID: "",
						operatingSystem: "",
						osImage: "ContainerOSVersion",
						systemUUID: "",
					},
				},
			},
		},
		{
			desc: "DisableNodeKubeProxyVersion FeatureGate enable, KubeProxyVersion will be cleared if it is set.",
			node: {
				status: {
					nodeInfo: {
						architecture: "",
						bootID: "",
						containerRuntimeVersion: "RuntimeType://RuntimeVersion",
						kernelVersion: "KernelVersion",
						kubeProxyVersion: "",
						kubeletVersion,
						machineID: "",
						operatingSystem: "",
						osImage: "ContainerOSVersion",
						systemUUID: "",
					},
				},
			},
			versionInfo: {
				kernelVersion: "KernelVersion",
				containerOsVersion: "ContainerOSVersion",
			},
			runtimeType: "RuntimeType",
			runtimeVersion: new FakeVersion("RuntimeVersion"),
			expectNode: {
				status: {
					nodeInfo: {
						architecture: "",
						bootID: "",
						containerRuntimeVersion: "RuntimeType://RuntimeVersion",
						kernelVersion: "KernelVersion",
						kubeProxyVersion: "",
						kubeletVersion,
						machineID: "",
						operatingSystem: "",
						osImage: "ContainerOSVersion",
						systemUUID: "",
					},
				},
			},
		},
	];

	for (const tc of cases) {
		it(tc.desc, async () => {
			const setter = versionInfo(
				() => [tc.versionInfo, tc.versionInfoError],
				() => tc.runtimeType ?? "",
				async () => [tc.runtimeVersion, tc.runtimeVersionError],
			);

			const err = await setter(context.background(), tc.node);

			expect(err).toEqual(tc.expectError);
			expect(tc.node).toEqual(tc.expectNode);
		});
	}
});

// Models kubernetes/pkg/kubelet/nodestatus/setters_test.go TestImages.
browser.describe("Images", () => {
	const cases: Array<{
		desc: string;
		maxImages: number;
		imageList: Image[];
		imageListError?: Error;
		expectError?: Error;
	}> = [
		{
			desc: "max images enforced",
			maxImages: 1,
			imageList: makeImageList(2, 1),
		},
		{
			desc: "no max images cap for -1",
			maxImages: -1,
			imageList: makeImageList(2, 1),
		},
		{
			desc: "max names per image enforced",
			maxImages: -1,
			imageList: makeImageList(1, maxNamesPerImageInNodeStatus + 1),
		},
		{
			desc: "images are sorted by size, descending",
			maxImages: -1,
			imageList: [
				newImage({ size: 3 }),
				newImage({ size: 1 }),
				newImage({ size: 4 }),
				newImage({ size: 2 }),
			],
		},
		{
			desc: "repo digests and tags both show up in image names",
			maxImages: -1,
			imageList: [newImage({ repoDigests: ["foo", "bar"], repoTags: ["baz", "quux"] })],
		},
		{
			desc: "error getting image list, image list on node is reset to empty",
			maxImages: -1,
			imageList: [],
			imageListError: new Error("foo"),
			expectError: new Error("error getting image list: foo"),
		},
	];

	for (const tc of cases) {
		it(tc.desc, async () => {
			const setter = images(tc.maxImages, async () => {
				return [[...tc.imageList].sort((a, b) => b.size - a.size), tc.imageListError];
			});
			const node: V1Node = {};

			const err = await setter(context.background(), node);

			expect(err).toEqual(tc.expectError);
			const expectNode: V1Node = {};
			if (!err) {
				expectNode.status = {
					images: makeExpectedImageList(tc.imageList, tc.maxImages, maxNamesPerImageInNodeStatus),
				};
			} else {
				expectNode.status = { images: [] };
			}
			expect(node).toEqual(expectNode);
		});
	}
});

// Models kubernetes/pkg/kubelet/nodestatus/setters_test.go TestDaemonEndpoints.
browser.describe("DaemonEndpoints", () => {
	for (const test of [
		{
			name: "empty daemon endpoints",
			endpoints: {},
			expected: { kubeletEndpoint: { Port: 0 } },
		},
		{
			name: "daemon endpoints with specific port",
			endpoints: { kubeletEndpoint: { Port: 5678 } },
			expected: { kubeletEndpoint: { Port: 5678 } },
		},
	]) {
		it(test.name, async () => {
			const existingNode: V1Node = {
				metadata: { name: "test-hostname" },
				spec: {},
				status: {
					addresses: [],
				},
			};

			const setter = daemonEndpoints(test.endpoints);
			const err = await setter(context.background(), existingNode);

			expect(err).toBeUndefined();
			expect(existingNode.status?.daemonEndpoints).toEqual(test.expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/nodestatus/setters.go GoRuntime.
browser.describe("GoRuntime", () => {
	it("sets operating system and architecture", async () => {
		const node: V1Node = {};

		const err = await goRuntime()(context.background(), node);

		expect(err).toBeUndefined();
		expect(node.status?.nodeInfo?.operatingSystem).toBe("linux");
		expect(node.status?.nodeInfo?.architecture).toBe("amd64");
	});
});

// Models kubernetes/pkg/kubelet/nodestatus/setters.go RuntimeHandlers.
browser.describe("RuntimeHandlers", () => {
	it("sets runtime handlers", async () => {
		const node: V1Node = {};

		const err = await runtimeHandlers(() => [
			new RuntimeHandler({
				name: "runc",
				supportsRecursiveReadOnlyMounts: true,
				supportsUserNamespaces: true,
			}),
		])(context.background(), node);

		expect(err).toBeUndefined();
		expect(node.status?.runtimeHandlers).toEqual([
			{
				name: "runc",
				features: {
					recursiveReadOnlyMounts: true,
					userNamespaces: true,
				},
			},
		]);
	});
});

// Models kubernetes/pkg/kubelet/nodestatus/setters.go NodeFeatures.
browser.describe("NodeFeatures", () => {
	it("sets runtime node features", async () => {
		const node: V1Node = {};

		const err = await nodeFeatures(() => new RuntimeFeatures({ supplementalGroupsPolicy: true }))(
			context.background(),
			node,
		);

		expect(err).toBeUndefined();
		expect(node.status?.features).toEqual({ supplementalGroupsPolicy: true });
	});

	it("leaves features unset when runtime features are not known", async () => {
		const node: V1Node = {};

		const err = await nodeFeatures(() => undefined)(context.background(), node);

		expect(err).toBeUndefined();
		expect(node.status?.features).toBeUndefined();
	});
});

function newImage(image: Partial<Image> = {}): Image {
	return {
		id: image.id ?? "",
		repoTags: image.repoTags ?? [],
		repoDigests: image.repoDigests ?? [],
		size: image.size ?? 0,
		spec: image.spec ?? { image: "" },
		pinned: image.pinned ?? false,
	};
}

function makeImageList(numImages: number, numTags: number): Image[] {
	return Array.from({ length: numImages }, (_, i) =>
		newImage({
			id: `image-${i}`,
			repoTags: makeImageTags(numTags),
			size: 23 * 1024 * 1024 + i,
		}),
	);
}

function makeExpectedImageList(
	imageList: Image[],
	maxImages: number,
	maxNames: number,
): NonNullable<NonNullable<V1Node["status"]>["images"]> {
	const expectedImages = [...imageList]
		.sort((a, b) => b.size - a.size)
		.map((image) => ({
			names: [...image.repoDigests, ...image.repoTags].slice(0, maxNames),
			sizeBytes: image.size,
		}));
	if (maxImages > -1 && maxImages < expectedImages.length) {
		return expectedImages.slice(0, maxImages);
	}
	return expectedImages;
}

function makeImageTags(num: number): string[] {
	return Array.from({ length: num }, (_, i) => `registry.k8s.io:v${i}`);
}
