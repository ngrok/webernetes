// Models vendor/k8s.io/utils/internal/third_party/forked/golang/net/ip.go ParseIP.
export function parseIP(value: string): number[] | undefined {
	for (const char of value) {
		switch (char) {
			case ".":
				return parseIPv4Sloppy(value);
			case ":":
				return parseIPv6Sloppy(value);
			default:
				break;
		}
	}
	return undefined;
}

function parseIPv4Sloppy(value: string): number[] | undefined {
	const parts = value.split(".");
	if (parts.length !== 4) {
		return undefined;
	}

	const octets: number[] = [];
	for (const part of parts) {
		if (!/^[0-9]+$/.test(part)) {
			return undefined;
		}
		const octet = Number.parseInt(part, 10);
		if (octet < 0 || octet > 255) {
			return undefined;
		}
		octets.push(octet);
	}
	return ipv4(octets[0], octets[1], octets[2], octets[3]);
}

function parseIPv6Sloppy(value: string): number[] | undefined {
	const ip = Array.from({ length: ipv6Len }, () => 0);
	let remaining = value;
	let ellipsis = -1;
	let i = 0;

	if (remaining.startsWith("::")) {
		ellipsis = 0;
		remaining = remaining.slice(2);
		if (remaining.length === 0) {
			return ip;
		}
	}

	while (i < ipv6Len) {
		const [n, c, ok] = xtoi(remaining);
		if (!ok || n > 0xffff) {
			return undefined;
		}

		if (c < remaining.length && remaining[c] === ".") {
			if (ellipsis < 0 && i !== ipv6Len - ipv4Len) {
				return undefined;
			}
			if (i + ipv4Len > ipv6Len) {
				return undefined;
			}
			const ip4 = parseIPv4Sloppy(remaining);
			if (!ip4) {
				return undefined;
			}
			ip[i] = ip4[12];
			ip[i + 1] = ip4[13];
			ip[i + 2] = ip4[14];
			ip[i + 3] = ip4[15];
			remaining = "";
			i += ipv4Len;
			break;
		}

		ip[i] = (n >> 8) & 0xff;
		ip[i + 1] = n & 0xff;
		i += 2;
		remaining = remaining.slice(c);
		if (remaining.length === 0) {
			break;
		}

		if (remaining[0] !== ":" || remaining.length === 1) {
			return undefined;
		}
		remaining = remaining.slice(1);

		if (remaining[0] === ":") {
			if (ellipsis >= 0) {
				return undefined;
			}
			ellipsis = i;
			remaining = remaining.slice(1);
			if (remaining.length === 0) {
				break;
			}
		}
	}

	if (remaining.length !== 0) {
		return undefined;
	}
	if (i < ipv6Len) {
		if (ellipsis < 0) {
			return undefined;
		}
		const n = ipv6Len - i;
		for (let j = i - 1; j >= ellipsis; j--) {
			ip[j + n] = ip[j];
		}
		for (let j = ellipsis + n - 1; j >= ellipsis; j--) {
			ip[j] = 0;
		}
	} else if (ellipsis >= 0) {
		return undefined;
	}
	return ip;
}

function xtoi(value: string): [n: number, c: number, ok: boolean] {
	let n = 0;
	let c = 0;
	for (; c < value.length; c++) {
		const digit = hexDigit(value.charCodeAt(c));
		if (digit === undefined) {
			break;
		}
		n = n * 16 + digit;
		if (n >= big) {
			return [0, c, false];
		}
	}
	return [n, c, c > 0];
}

function hexDigit(charCode: number): number | undefined {
	if (charCode >= 48 && charCode <= 57) {
		return charCode - 48;
	}
	if (charCode >= 65 && charCode <= 70) {
		return charCode - 65 + 10;
	}
	if (charCode >= 97 && charCode <= 102) {
		return charCode - 97 + 10;
	}
	return undefined;
}

const ipv4Len = 4;
const ipv6Len = 16;
const big = 0xffffff;

function ipv4(a: number, b: number, c: number, d: number): number[] {
	return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, a, b, c, d];
}
