import type { V1Node } from "../../client";
import { formatIP } from "../../go/net";
import { isIPv6, parseIPSloppy } from "../../utils/net";

function formatNodeAddresses(addresses: NonNullable<V1Node["status"]>["addresses"]): string {
	return `[${(addresses ?? []).map((address) => `{${address.type} ${address.address}}`).join(" ")}]`;
}

// Models kubernetes/pkg/util/node/node.go NoMatchError.
class NoMatchError extends Error {
	constructor(addresses: NonNullable<V1Node["status"]>["addresses"]) {
		super(`no preferred addresses found; known addresses: ${formatNodeAddresses(addresses)}`);
	}
}

// Models kubernetes/pkg/util/node/node.go GetPreferredNodeAddress.
export function getPreferredNodeAddress(
	node: V1Node,
	preferredAddressTypes: string[],
): [address: string, err: Error | undefined] {
	for (const addressType of preferredAddressTypes) {
		for (const address of node.status?.addresses ?? []) {
			if (address.type === addressType) {
				return [address.address, undefined];
			}
		}
	}
	return ["", new NoMatchError(node.status?.addresses)];
}

// Models kubernetes/pkg/util/node/node.go GetNodeHostIPs.
export function getNodeHostIPs(node: V1Node): [nodeIPs: string[], err: Error | undefined] {
	const allIPs: number[][] = [];
	for (const address of node.status?.addresses ?? []) {
		if (address.type === "InternalIP") {
			const ip = parseIPSloppy(address.address);
			if (ip) {
				allIPs.push(ip);
			}
		}
	}
	for (const address of node.status?.addresses ?? []) {
		if (address.type === "ExternalIP") {
			const ip = parseIPSloppy(address.address);
			if (ip) {
				allIPs.push(ip);
			}
		}
	}
	if (allIPs.length === 0) {
		return [
			[],
			new Error(
				`host IP unknown; known addresses: ${JSON.stringify(node.status?.addresses ?? [])}`,
			),
		];
	}

	const nodeIPs = [allIPs[0]];
	for (const ip of allIPs) {
		if (isIPv6(ip) !== isIPv6(nodeIPs[0])) {
			nodeIPs.push(ip);
			break;
		}
	}

	return [nodeIPs.map((ip) => formatIP(ip)), undefined];
}

// Models kubernetes/pkg/util/node/node.go IsNodeReady.
export function isNodeReady(node: V1Node): boolean {
	for (const condition of node.status?.conditions ?? []) {
		if (condition.type === "Ready") {
			return condition.status === "True";
		}
	}
	return false;
}
