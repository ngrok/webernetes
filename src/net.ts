const IP_ADDRESS_REGEX = /^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.?\b){4}$/;

export class CIDR {
	readonly first: number;
	readonly last: number;

	static valid(cidr: string): boolean {
		const split = cidr.split("/");
		if (split.length !== 2) {
			return false;
		}
		const [range, prefixText] = split;
		const prefix = Number(prefixText);
		return IP_ADDRESS_REGEX.test(range) && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
	}

	constructor(cidr: string) {
		if (!CIDR.valid(cidr)) {
			throw new Error(`Invalid CIDR range: ${cidr}`);
		}
		const [range, prefixText] = cidr.split("/");
		const prefix = Number(prefixText);
		const base = ipToNumber(range);
		if (base === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
			throw new Error(`Invalid CIDR range: ${cidr}`);
		}

		const size = 2 ** (32 - prefix);
		const network = Math.floor(base / size) * size;
		this.first = size <= 2 ? network : network + 1;
		this.last = size <= 2 ? network + size - 1 : network + size - 2;
	}

	contains(ip: string): boolean {
		const value = ipToNumber(ip);
		return value !== undefined && value >= this.first && value <= this.last;
	}

	firstAddress(): string | undefined {
		return this.first <= this.last ? numberToIp(this.first) : undefined;
	}

	addressAfter(ip: string): string | undefined {
		const value = ipToNumber(ip);
		if (value === undefined || !this.contains(ip) || value >= this.last) {
			return undefined;
		}
		return numberToIp(value + 1);
	}

	*addresses(): Iterable<string> {
		for (let value = this.first; value <= this.last; value++) {
			yield numberToIp(value);
		}
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
