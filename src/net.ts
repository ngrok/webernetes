import { formatIP, parseIP } from "./go/net";

export class CIDR {
	private readonly family: 4 | 6;
	private readonly network: bigint;
	private readonly broadcast: bigint;
	private readonly usableFirst: bigint;
	private readonly usableLast: bigint;

	static valid(cidr: string): boolean {
		const split = cidr.split("/");
		if (split.length !== 2) {
			return false;
		}
		const [range, prefixText] = split;
		const prefix = Number(prefixText);
		const family = ipFamily(range);
		const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : undefined;
		return (
			maxPrefix !== undefined && Number.isInteger(prefix) && prefix >= 0 && prefix <= maxPrefix
		);
	}

	constructor(cidr: string) {
		if (!CIDR.valid(cidr)) {
			throw new Error(`Invalid CIDR range: ${cidr}`);
		}
		const [range, prefixText] = cidr.split("/");
		const prefix = Number(prefixText);
		const family = ipFamily(range);
		const base = ipToBigInt(range);
		const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : undefined;
		if (
			family === undefined ||
			base === undefined ||
			maxPrefix === undefined ||
			!Number.isInteger(prefix) ||
			prefix < 0 ||
			prefix > maxPrefix
		) {
			throw new Error(`Invalid CIDR range: ${cidr}`);
		}

		const size = 1n << BigInt(maxPrefix - prefix);
		this.family = family;
		this.network = (base / size) * size;
		this.broadcast = this.network + size - 1n;
		this.usableFirst = family === 4 && size > 2n ? this.network + 1n : this.network;
		this.usableLast = family === 4 && size > 2n ? this.broadcast - 1n : this.broadcast;
	}

	get first(): number {
		return this.ipv4Number(this.usableFirst);
	}

	get last(): number {
		return this.ipv4Number(this.usableLast);
	}

	contains(ip: string): boolean {
		const family = ipFamily(ip);
		const value = ipToBigInt(ip);
		return (
			family === this.family &&
			value !== undefined &&
			value >= this.network &&
			value <= this.broadcast
		);
	}

	containsUsableAddress(ip: string): boolean {
		const family = ipFamily(ip);
		const value = ipToBigInt(ip);
		return (
			family === this.family &&
			value !== undefined &&
			value >= this.usableFirst &&
			value <= this.usableLast
		);
	}

	firstAddress(): string | undefined {
		return this.usableFirst <= this.usableLast ? this.formatValue(this.usableFirst) : undefined;
	}

	addressAfter(ip: string): string | undefined {
		const value = ipToBigInt(ip);
		if (value === undefined || !this.containsUsableAddress(ip) || value >= this.usableLast) {
			return undefined;
		}
		return this.formatValue(value + 1n);
	}

	*addresses(): Iterable<string> {
		for (let value = this.usableFirst; value <= this.usableLast; value++) {
			yield this.formatValue(value);
		}
	}

	private ipv4Number(value: bigint): number {
		if (this.family !== 4) {
			throw new Error("CIDR numeric bounds are only available for IPv4 ranges");
		}
		return Number(value);
	}

	private formatValue(value: bigint): string {
		return this.family === 4 ? numberToIp(Number(value)) : bigIntToIPv6(value);
	}
}

export function ipToNumber(ip: string): number | undefined {
	const parts = ip.split(".");
	if (parts.length !== 4) {
		return undefined;
	}

	let value = 0;
	for (const part of parts) {
		if (!/^\d+$/.test(part)) {
			return undefined;
		}

		const octet = Number(part);
		if (octet < 0 || octet > 255) {
			return undefined;
		}

		value = value * 256 + octet;
	}

	return value >>> 0;
}

export function numberToIp(value: number): string {
	return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

export function isIPLiteral(ip: string): boolean {
	return parseIP(normalizeIPLiteral(ip)) !== undefined;
}

function ipFamily(ip: string): 4 | 6 | undefined {
	const parsed = parseIP(normalizeIPLiteral(ip));
	if (!parsed) {
		return undefined;
	}
	return isIPv4(parsed) ? 4 : 6;
}

function ipToBigInt(ip: string): bigint | undefined {
	const parsed = parseIP(normalizeIPLiteral(ip));
	if (!parsed) {
		return undefined;
	}
	const bytes = isIPv4(parsed) ? parsed.slice(12) : parsed;
	let value = 0n;
	for (const byte of bytes) {
		value = (value << 8n) + BigInt(byte);
	}
	return value;
}

function bigIntToIPv6(value: bigint): string {
	const bytes = Array.from({ length: 16 }, (_, index) =>
		Number((value >> BigInt((15 - index) * 8)) & 0xffn),
	);
	return formatIP(bytes);
}

function isIPv4(ip: number[]): boolean {
	return (
		ip.length === 16 &&
		ip.slice(0, 10).every((byte) => byte === 0) &&
		ip[10] === 0xff &&
		ip[11] === 0xff
	);
}

function normalizeIPLiteral(ip: string): string {
	return ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
}
