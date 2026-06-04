import { parseIPSloppy } from "./parse";

export type IPFamily = "" | "4" | "6";

// Models vendor/k8s.io/utils/net/ipfamily.go IPFamilyUnknown.
export const ipFamilyUnknown: IPFamily = "";
// Models vendor/k8s.io/utils/net/ipfamily.go IPv4.
export const ipv4: IPFamily = "4";
// Models vendor/k8s.io/utils/net/ipfamily.go IPv6.
export const ipv6: IPFamily = "6";

// Models vendor/k8s.io/utils/net/ipfamily.go IPFamilyOf.
export function ipFamilyOf(ip: number[] | undefined): IPFamily {
	switch (true) {
		case ip !== undefined &&
			ip.length === 16 &&
			ip.slice(0, 10).every((octet) => octet === 0) &&
			ip[10] === 0xff &&
			ip[11] === 0xff:
			return ipv4;
		case ip !== undefined && ip.length === 16:
			return ipv6;
		default:
			return ipFamilyUnknown;
	}
}

// Models vendor/k8s.io/utils/net/ipfamily.go IPFamilyOfString.
export function ipFamilyOfString(ip: string): IPFamily {
	return ipFamilyOf(parseIPSloppy(ip));
}

// Models vendor/k8s.io/utils/net/ipfamily.go IsIPv6.
export function isIPv6(netIP: number[] | undefined): boolean {
	return ipFamilyOf(netIP) === ipv6;
}

// Models vendor/k8s.io/utils/net/ipfamily.go IsIPv6String.
export function isIPv6String(ip: string): boolean {
	return ipFamilyOfString(ip) === ipv6;
}

// Models vendor/k8s.io/utils/net/ipfamily.go IsIPv4.
export function isIPv4(netIP: number[] | undefined): boolean {
	return ipFamilyOf(netIP) === ipv4;
}

// Models vendor/k8s.io/utils/net/ipfamily.go IsIPv4String.
export function isIPv4String(ip: string): boolean {
	return ipFamilyOfString(ip) === ipv4;
}
