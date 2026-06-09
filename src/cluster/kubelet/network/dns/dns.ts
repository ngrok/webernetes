/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1ObjectReference, V1Pod } from "../../../../client";
import * as context from "../../../../go/context";
import { dns1123SubdomainMaxLength } from "../../../../apimachinery/pkg/util/validation/validation";
import {
	maxDNSNameservers,
	maxDNSSearchListChars,
	maxDNSSearchPaths,
} from "../../../apis/core/validation/validation";
import type { DnsConfig } from "../../../cri";
import type { EventRecorder } from "../../../../client-go/tools/record/event";
import { isHostNetworkPod } from "../../container";

export type PodDNSConfig = NonNullable<NonNullable<V1Pod["spec"]>["dnsConfig"]>;
export type PodDNSType = "cluster" | "host" | "none";
type DNSPolicy = "None" | "ClusterFirstWithHostNet" | "ClusterFirst" | "Default";

const defaultDNSOptions = ["ndots:5"];

export interface ConfigurerOptions {
	recorder: EventRecorder;
	nodeRef: V1ObjectReference;
	nodeIPs?: string[];
	clusterDNS?: string[];
	clusterDomain: string;
	resolverConfig: string;
	getHostDNSConfig?: (
		resolverConfig: string,
	) => [dnsConfig: DnsConfig | undefined, err: Error | undefined];
}

// Models kubernetes/pkg/kubelet/network/dns/dns.go Configurer.
export class Configurer {
	private readonly recorder: EventRecorder;
	private readonly getHostDNSConfig: (
		resolverConfig: string,
	) => [dnsConfig: DnsConfig | undefined, err: Error | undefined];
	private readonly nodeRef: V1ObjectReference;
	private readonly nodeIPs: string[];
	clusterDNS: string[];
	clusterDomain: string;
	resolverConfig: string;

	constructor(options: ConfigurerOptions) {
		this.recorder = options.recorder;
		this.getHostDNSConfig = options.getHostDNSConfig ?? getDNSConfig;
		this.nodeRef = options.nodeRef;
		this.nodeIPs = options.nodeIPs ? [...options.nodeIPs] : [];
		this.clusterDNS = options.clusterDNS ? [...options.clusterDNS] : [];
		this.clusterDomain = options.clusterDomain;
		this.resolverConfig = options.resolverConfig;
	}

	// Models kubernetes/pkg/kubelet/network/dns/dns.go Configurer.generateSearchesForDNSClusterFirst.
	generateSearchesForDNSClusterFirst(hostSearch: string[], pod: V1Pod): string[] {
		if (this.clusterDomain === "") {
			return hostSearch;
		}

		const namespace = pod.metadata?.namespace ?? "";
		const nsSvcDomain = `${namespace}.svc.${this.clusterDomain}`;
		const svcDomain = `svc.${this.clusterDomain}`;
		const clusterSearch = [nsSvcDomain, svcDomain, this.clusterDomain];

		return omitDuplicates([...clusterSearch, ...hostSearch]);
	}

	// Models kubernetes/pkg/kubelet/network/dns/dns.go Configurer.GetPodDNS.
	async getPodDNS(
		ctx: context.Context,
		pod: V1Pod,
	): Promise<[dnsConfig: DnsConfig | undefined, err: Error | undefined]> {
		void ctx;
		let [dnsConfig, hostDNSErr] = this.getHostDNSConfig(this.resolverConfig);
		if (hostDNSErr !== undefined || dnsConfig === undefined) {
			return [undefined, hostDNSErr ?? new Error("failed to get host DNS config")];
		}

		let [dnsType, err] = getPodDNSType(pod);
		if (err) {
			dnsType = "cluster";
		}

		switch (dnsType) {
			case "none":
				dnsConfig = { servers: [], searches: [], options: [] };
				break;
			case "cluster":
				if (this.clusterDNS.length !== 0) {
					dnsConfig.servers = [...this.clusterDNS];
					dnsConfig.searches = this.generateSearchesForDNSClusterFirst(dnsConfig.searches, pod);
					dnsConfig.options = [...defaultDNSOptions];
					break;
				}
				const nodeErrorMsg =
					'kubelet does not have ClusterDNS IP configured and cannot create Pod using "ClusterFirst" policy. Falling back to "Default" policy.';
				await this.recorder.eventf(
					this.nodeRef,
					"Warning",
					"MissingClusterDNS",
					"%s",
					nodeErrorMsg,
				);
				await this.recorder.eventf(
					pod,
					"Warning",
					"MissingClusterDNS",
					"pod: %q. %s",
					formatPod(pod),
					nodeErrorMsg,
				);
			// fall through
			case "host":
				if (this.resolverConfig === "") {
					dnsConfig.servers = [];
					for (const nodeIP of this.nodeIPs) {
						dnsConfig.servers.push(isIPv6String(nodeIP) ? "::1" : "127.0.0.1");
					}
					if (dnsConfig.servers.length === 0) {
						dnsConfig.servers.push("127.0.0.1");
					}
					dnsConfig.searches = ["."];
				}
				break;
		}

		if (pod.spec?.dnsConfig) {
			dnsConfig = appendDNSConfig(dnsConfig, pod.spec.dnsConfig);
		}
		return [await this.formDNSConfigFitsLimits(dnsConfig, pod), undefined];
	}

	// Models kubernetes/pkg/kubelet/network/dns/dns.go Configurer.formDNSSearchFitsLimits.
	async formDNSSearchFitsLimits(composedSearch: string[], pod: V1Pod): Promise<string[]> {
		let limitsExceeded = false;

		if (composedSearch.length > maxDNSSearchPaths) {
			composedSearch = composedSearch.slice(0, maxDNSSearchPaths);
			limitsExceeded = true;
		}

		const filteredSearch: string[] = [];
		for (const search of composedSearch) {
			if (search.length > dns1123SubdomainMaxLength) {
				limitsExceeded = true;
				continue;
			}
			filteredSearch.push(search);
		}
		composedSearch = filteredSearch;

		const resolvSearchLineStrLen = composedSearch.join(" ").length;
		if (resolvSearchLineStrLen > maxDNSSearchListChars) {
			let cutDomainsNum = 0;
			let cutDomainsLen = 0;
			for (let i = composedSearch.length - 1; i >= 0; i--) {
				cutDomainsLen += composedSearch[i].length + 1;
				cutDomainsNum++;

				if (resolvSearchLineStrLen - cutDomainsLen <= maxDNSSearchListChars) {
					break;
				}
			}

			composedSearch = composedSearch.slice(0, composedSearch.length - cutDomainsNum);
			limitsExceeded = true;
		}

		if (limitsExceeded) {
			const err = new Error(
				`Search Line limits were exceeded, some search paths have been omitted, the applied search line is: ${composedSearch.join(" ")}`,
			);
			await this.recorder.event(pod, "Warning", "DNSConfigForming", err.message);
		}
		return composedSearch;
	}

	// Models kubernetes/pkg/kubelet/network/dns/dns.go Configurer.formDNSNameserversFitsLimits.
	async formDNSNameserversFitsLimits(nameservers: string[], pod: V1Pod): Promise<string[]> {
		if (nameservers.length > maxDNSNameservers) {
			nameservers = nameservers.slice(0, maxDNSNameservers);
			const err = new Error(
				`Nameserver limits were exceeded, some nameservers have been omitted, the applied nameserver line is: ${nameservers.join(" ")}`,
			);
			await this.recorder.event(pod, "Warning", "DNSConfigForming", err.message);
		}
		return nameservers;
	}

	// Models kubernetes/pkg/kubelet/network/dns/dns.go Configurer.formDNSConfigFitsLimits.
	private async formDNSConfigFitsLimits(dnsConfig: DnsConfig, pod: V1Pod): Promise<DnsConfig> {
		dnsConfig.servers = await this.formDNSNameserversFitsLimits(dnsConfig.servers, pod);
		dnsConfig.searches = await this.formDNSSearchFitsLimits(dnsConfig.searches, pod);
		return dnsConfig;
	}
}

// Models kubernetes/pkg/kubelet/network/dns/dns.go getDNSConfig.
export function getDNSConfig(_resolverConfigFile: string): [dnsConfig: DnsConfig, err: undefined] {
	// Upstream this parses resolv.conf, we don't do that in the browser.
	return [{ servers: [], searches: [], options: [] }, undefined];
}

// Models kubernetes/pkg/kubelet/network/dns/dns.go getPodDNSType.
export function getPodDNSType(pod: V1Pod): [podDNSType: PodDNSType, err: Error | undefined] {
	const dnsPolicy = pod.spec?.dnsPolicy ?? "ClusterFirst";
	switch (dnsPolicy as DNSPolicy) {
		case "None":
			return ["none", undefined];
		case "ClusterFirstWithHostNet":
			return ["cluster", undefined];
		case "ClusterFirst":
			return [isHostNetworkPod(pod) ? "host" : "cluster", undefined];
		case "Default":
			return ["host", undefined];
		default:
			return ["cluster", new Error(`invalid DNSPolicy=${dnsPolicy}`)];
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

function isIPv6String(ip: string): boolean {
	return ip.includes(":");
}

function formatPod(pod: V1Pod): string {
	const namespace = pod.metadata?.namespace ?? "default";
	const name = pod.metadata?.name ?? "";
	const uid = pod.metadata?.uid ?? "";
	return `${namespace}/${name} (${uid})`;
}
