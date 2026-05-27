import type { V1Pod } from "../../../../client";
import type { DnsConfig } from "../../../cri";
import { isHostNetworkPod } from "../../container";

export type PodDNSConfig = NonNullable<NonNullable<V1Pod["spec"]>["dnsConfig"]>;
export type PodDNSType = "cluster" | "host" | "none";

// Models kubernetes/pkg/kubelet/network/dns/dns.go getPodDNSType.
export function getPodDNSType(pod: V1Pod): PodDNSType {
	switch (pod.spec?.dnsPolicy ?? "ClusterFirst") {
		case "None":
			return "none";
		case "ClusterFirstWithHostNet":
			return "cluster";
		case "ClusterFirst":
			return isHostNetworkPod(pod) ? "host" : "cluster";
		case "Default":
			return "host";
		default:
			return "cluster";
	}
}

// Models kubernetes/pkg/kubelet/network/dns/dns.go appendDNSConfig.
export function appendDNSConfig(existingDNSConfig: DnsConfig, dnsConfig: PodDNSConfig): DnsConfig {
	existingDNSConfig.servers = omitDuplicates([
		...existingDNSConfig.servers,
		...(dnsConfig.nameservers ?? []),
	]);
	existingDNSConfig.searches = omitDuplicates([
		...existingDNSConfig.searches,
		...(dnsConfig.searches ?? []),
	]);
	existingDNSConfig.options = mergeDNSOptions(existingDNSConfig.options, dnsConfig.options ?? []);
	return existingDNSConfig;
}

// Models kubernetes/pkg/kubelet/network/dns/dns.go mergeDNSOptions.
function mergeDNSOptions(
	existingDNSConfigOptions: string[],
	dnsConfigOptions: PodDNSConfig["options"],
): string[] {
	const optionsMap = new Map<string, string>();
	for (const op of existingDNSConfigOptions) {
		const index = op.indexOf(":");
		if (index !== -1) {
			optionsMap.set(op.slice(0, index), op.slice(index + 1));
		} else {
			optionsMap.set(op, "");
		}
	}
	for (const op of dnsConfigOptions ?? []) {
		optionsMap.set(op.name ?? "", op.value ?? "");
	}
	return [...optionsMap.entries()].map(([opName, opValue]) =>
		opValue === "" ? opName : `${opName}:${opValue}`,
	);
}

// Models kubernetes/pkg/kubelet/network/dns/dns.go omitDuplicates.
function omitDuplicates(values: string[]): string[] {
	return [...new Set(values)];
}
