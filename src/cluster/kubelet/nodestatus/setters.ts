/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1Node, V1NodeDaemonEndpoints } from "../../../client";
import { newNodeSystemInfo } from "../../../client";
import { formatIP, isUnspecifiedIP } from "../../../go/net";
import type * as context from "../../../go/context";
import { isIPv4, parseIPSloppy } from "../../../utils/net";
import type { Image, RuntimeFeatures, RuntimeHandler, Version } from "../container";

// Models kubernetes/pkg/kubelet/nodestatus/setters.go MaxNamesPerImageInNodeStatus.
export const maxNamesPerImageInNodeStatus = 5;

// Models kubernetes/pkg/kubelet/nodestatus/setters.go Setter.
export type Setter = (ctx: context.Context, node: V1Node) => Promise<Error | undefined>;

// Models k8s.io/component-base/version Get().String().
export const kubeletVersion = "v1.36.0";

// Models github.com/google/cadvisor/info/v1 VersionInfo fields used by
// kubernetes/pkg/kubelet/nodestatus/setters.go VersionInfo.
export interface CadvisorVersionInfo {
	kernelVersion: string;
	containerOsVersion: string;
}

// Models k8s.io/cloud-provider/api AnnotationAlphaProvidedIPAddr.
const annotationAlphaProvidedIPAddr = "alpha.kubernetes.io/provided-node-ip";

// Models kubernetes/pkg/kubelet/nodestatus/setters.go NodeAddress.
export function nodeAddress(
	nodeIPs: string[],
	validateNodeIPFunc: (nodeIP: string) => Error | undefined,
	hostname: string,
	externalCloudProvider: boolean,
	resolveAddressFunc: (
		nodeIP: string | undefined,
	) => [ip: string | undefined, err: Error | undefined],
): Setter {
	let nodeIP: string | undefined;
	let secondaryNodeIP: string | undefined;
	if (nodeIPs.length > 0) {
		nodeIP = nodeIPs[0];
	}
	const preferIPv4 = nodeIP === undefined || isIPv4(parseIPSloppy(nodeIP));
	const isPreferredIPFamily = (ip: string): boolean => isIPv4(parseIPSloppy(ip)) === preferIPv4;
	const nodeIPSpecified = nodeIP !== undefined && !isUnspecifiedIP(parseIPSloppy(nodeIP));

	if (nodeIPs.length > 1) {
		secondaryNodeIP = nodeIPs[1];
	}
	const secondaryNodeIPSpecified =
		secondaryNodeIP !== undefined && !isUnspecifiedIP(parseIPSloppy(secondaryNodeIP));

	return async (_ctx, node) => {
		node.status ??= {};
		if (nodeIPSpecified && nodeIP !== undefined) {
			const err = validateNodeIPFunc(nodeIP);
			if (err) {
				return new Error(`failed to validate nodeIP: ${err.message}`);
			}
		}
		if (secondaryNodeIPSpecified && secondaryNodeIP !== undefined) {
			const err = validateNodeIPFunc(secondaryNodeIP);
			if (err) {
				return new Error(`failed to validate secondaryNodeIP: ${err.message}`);
			}
		}

		node.metadata ??= {};
		if (externalCloudProvider && nodeIPSpecified && nodeIP !== undefined) {
			node.metadata.annotations ??= {};
			let annotation = nodeIP;
			if (secondaryNodeIPSpecified) {
				annotation += `,${secondaryNodeIP}`;
			}
			node.metadata.annotations[annotationAlphaProvidedIPAddr] = annotation;
		} else if (node.metadata.annotations) {
			delete node.metadata.annotations[annotationAlphaProvidedIPAddr];
		}

		if (externalCloudProvider) {
			if ((node.status.addresses ?? []).length > 0) {
				return undefined;
			}
			if (nodeIP === undefined) {
				node.status.addresses = [{ type: "Hostname", address: hostname }];
				return undefined;
			}
		}
		if (
			nodeIPSpecified &&
			secondaryNodeIPSpecified &&
			nodeIP !== undefined &&
			secondaryNodeIP !== undefined
		) {
			node.status.addresses = [
				{ type: "InternalIP", address: nodeIP },
				{ type: "InternalIP", address: secondaryNodeIP },
				{ type: "Hostname", address: hostname },
			];
		} else {
			let ipAddr: string | undefined;
			let err: Error | undefined;

			if (nodeIPSpecified) {
				ipAddr = nodeIP;
			} else {
				const addr = parseIPSloppy(hostname);
				if (addr) {
					ipAddr = formatIP(addr);
				} else {
					const addrs = lookupIP(node.metadata.name ?? "");
					for (const addr of addrs) {
						err = validateNodeIPFunc(addr);
						if (!err) {
							if (isPreferredIPFamily(addr)) {
								ipAddr = addr;
								break;
							} else if (ipAddr === undefined) {
								ipAddr = addr;
							}
						}
					}

					if (ipAddr === undefined) {
						const [resolvedIP, resolveErr] = resolveAddressFunc(nodeIP);
						ipAddr = resolvedIP;
						err = resolveErr;
					}
				}
			}

			if (ipAddr === undefined) {
				return new Error(`can't get ip address of node ${node.metadata.name ?? ""}. error: ${err}`);
			}
			node.status.addresses = [
				{ type: "InternalIP", address: ipAddr },
				{ type: "Hostname", address: hostname },
			];
		}
		return undefined;
	};
}

function lookupIP(_name: string): string[] {
	// No resolver in the browser so this defaults to nothing for now.
	return [];
}

// Models kubernetes/pkg/kubelet/nodestatus/setters.go VersionInfo.
export function versionInfo(
	versionInfoFunc: () => [versionInfo: CadvisorVersionInfo | undefined, err: Error | undefined],
	runtimeTypeFunc: () => string,
	runtimeVersionFunc: (
		ctx: context.Context,
	) => Promise<[runtimeVersion: Version | undefined, err: Error | undefined]>,
): Setter {
	return async (ctx, node) => {
		const [verinfo, err] = versionInfoFunc();
		if (err || !verinfo) {
			return new Error(`error getting version info: ${err?.message ?? "unknown"}`);
		}

		node.status ??= {};
		node.status.nodeInfo = newNodeSystemInfo(node.status.nodeInfo);
		node.status.nodeInfo.kernelVersion = verinfo.kernelVersion;
		node.status.nodeInfo.osImage = verinfo.containerOsVersion;

		let runtimeVersion = "Unknown";
		const [runtimeVer, runtimeErr] = await runtimeVersionFunc(ctx);
		if (!runtimeErr && runtimeVer) {
			runtimeVersion = runtimeVer.toString();
		}
		node.status.nodeInfo.containerRuntimeVersion = `${runtimeTypeFunc()}://${runtimeVersion}`;

		node.status.nodeInfo.kubeletVersion = kubeletVersion;
		node.status.nodeInfo.kubeProxyVersion = "";

		return undefined;
	};
}

// Models kubernetes/pkg/kubelet/nodestatus/setters.go DaemonEndpoints.
export function daemonEndpoints(endpoints: V1NodeDaemonEndpoints): Setter {
	return async (_ctx, node) => {
		node.status ??= {};
		node.status.daemonEndpoints = {
			kubeletEndpoint: endpoints.kubeletEndpoint ? { ...endpoints.kubeletEndpoint } : { Port: 0 },
		};
		return undefined;
	};
}

// Models kubernetes/pkg/kubelet/nodestatus/setters.go Images.
export function images(
	nodeStatusMaxImages: number,
	imageListFunc: (
		ctx: context.Context,
	) => Promise<[containerImages: Image[], err: Error | undefined]>,
): Setter {
	return async (ctx, node) => {
		let imagesOnNode: NonNullable<NonNullable<V1Node["status"]>["images"]> = [];
		let [containerImages, err] = await imageListFunc(ctx);
		if (err) {
			node.status ??= {};
			node.status.images = imagesOnNode;
			return new Error(`error getting image list: ${err.message}`);
		}
		if (nodeStatusMaxImages > -1 && nodeStatusMaxImages < containerImages.length) {
			containerImages = containerImages.slice(0, nodeStatusMaxImages);
		}

		for (const image of containerImages) {
			let names = [...image.repoDigests, ...image.repoTags];
			if (names.length > maxNamesPerImageInNodeStatus) {
				names = names.slice(0, maxNamesPerImageInNodeStatus);
			}
			imagesOnNode = [...imagesOnNode, { names, sizeBytes: image.size }];
		}

		node.status ??= {};
		node.status.images = imagesOnNode;
		return undefined;
	};
}

// Models kubernetes/pkg/kubelet/nodestatus/setters.go GoRuntime.
export function goRuntime(): Setter {
	return async (_ctx, node) => {
		node.status ??= {};
		node.status.nodeInfo = newNodeSystemInfo(node.status.nodeInfo);
		node.status.nodeInfo.operatingSystem = "linux";
		node.status.nodeInfo.architecture = "amd64";
		return undefined;
	};
}

// Models kubernetes/pkg/kubelet/nodestatus/setters.go NodeFeatures.
export function nodeFeatures(featuresGetter: () => RuntimeFeatures | undefined): Setter {
	return async (_ctx, node) => {
		const features = featuresGetter();
		if (!features) {
			return undefined;
		}
		node.status ??= {};
		node.status.features = {
			supplementalGroupsPolicy: features.supplementalGroupsPolicy,
		};
		return undefined;
	};
}

// Models kubernetes/pkg/kubelet/nodestatus/setters.go RuntimeHandlers.
export function runtimeHandlers(fn: () => RuntimeHandler[]): Setter {
	return async (_ctx, node) => {
		const handlers = fn();
		node.status ??= {};
		node.status.runtimeHandlers = handlers.map((handler) => ({
			name: handler.name,
			features: {
				recursiveReadOnlyMounts: handler.supportsRecursiveReadOnlyMounts,
				userNamespaces: handler.supportsUserNamespaces,
			},
		}));
		return undefined;
	};
}
