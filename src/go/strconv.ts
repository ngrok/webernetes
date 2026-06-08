// Models go stdlib strconv.IntSize.
export const intSize = 64;

// Models internal/strconv ErrRange.
export const errRange = new Error("value out of range");
// Models internal/strconv ErrSyntax.
export const errSyntax = new Error("invalid syntax");
const errBase = new Error("invalid base");
const errBitSize = new Error("invalid bit size");

// Models go stdlib strconv.NumError.
export class NumError extends Error {
	constructor(
		readonly func: string,
		readonly num: string,
		readonly err: Error,
	) {
		super(`strconv.${func}: parsing ${quote(num)}: ${err.message}`);
	}
}

// Models go stdlib strconv.ParseUint.
export function parseUint(
	s: string,
	base: number,
	bitSize: number,
): [i: bigint, err: Error | undefined] {
	const [x, err] = parseUintInternal(s, base, bitSize);
	if (err) {
		return [x, toError("ParseUint", s, base, bitSize, err)];
	}
	return [x, undefined];
}

// Models go stdlib strconv.ParseInt.
export function parseInt(
	s: string,
	base: number,
	bitSize: number,
): [i: bigint, err: Error | undefined] {
	const [x, err] = parseIntInternal(s, base, bitSize);
	if (err) {
		return [x, toError("ParseInt", s, base, bitSize, err)];
	}
	return [x, undefined];
}

// Models internal/strconv.ParseUint.
function parseUintInternal(
	s: string,
	base: number,
	bitSize: number,
): [i: bigint, err: Error | undefined] {
	if (s === "") {
		return [0n, errSyntax];
	}

	const base0 = base === 0;

	const s0 = s;
	switch (true) {
		case 2 <= base && base <= 36:
			break;

		case base === 0:
			base = 10;
			if (s[0] === "0") {
				switch (true) {
					case s.length >= 3 && lower(s[1] ?? "") === "b":
						base = 2;
						s = s.slice(2);
						break;
					case s.length >= 3 && lower(s[1] ?? "") === "o":
						base = 8;
						s = s.slice(2);
						break;
					case s.length >= 3 && lower(s[1] ?? "") === "x":
						base = 16;
						s = s.slice(2);
						break;
					default:
						base = 8;
						s = s.slice(1);
						break;
				}
			}
			break;

		default:
			return [0n, errBase];
	}

	if (bitSize === 0) {
		bitSize = intSize;
	} else if (bitSize < 0 || bitSize > 64) {
		return [0n, errBitSize];
	}

	let cutoff: bigint;
	switch (base) {
		case 10:
			cutoff = maxUint64 / 10n + 1n;
			break;
		case 16:
			cutoff = maxUint64 / 16n + 1n;
			break;
		default:
			cutoff = maxUint64 / BigInt(base) + 1n;
			break;
	}

	const maxVal = (1n << BigInt(bitSize)) - 1n;

	let underscores = false;
	let n = 0n;
	for (let i = 0; i < s.length; i++) {
		const c = s[i] ?? "";
		let d: number;
		if (c === "_" && base0) {
			underscores = true;
			continue;
		}
		if ("0" <= c && c <= "9") {
			d = c.charCodeAt(0) - "0".charCodeAt(0);
		} else if ("a" <= lower(c) && lower(c) <= "z") {
			d = lower(c).charCodeAt(0) - "a".charCodeAt(0) + 10;
		} else {
			return [0n, errSyntax];
		}

		if (d >= base) {
			return [0n, errSyntax];
		}

		if (n >= cutoff) {
			return [maxVal, errRange];
		}
		n *= BigInt(base);

		const n1 = n + BigInt(d);
		if (n1 < n || n1 > maxVal) {
			return [maxVal, errRange];
		}
		n = n1;
	}

	if (underscores && !underscoreOK(s0)) {
		return [0n, errSyntax];
	}

	return [n, undefined];
}

// Models internal/strconv.ParseInt.
function parseIntInternal(
	s: string,
	base: number,
	bitSize: number,
): [i: bigint, err: Error | undefined] {
	if (s === "") {
		return [0n, errSyntax];
	}

	let neg = false;
	switch (s[0]) {
		case "+":
			s = s.slice(1);
			break;
		case "-":
			s = s.slice(1);
			neg = true;
			break;
	}

	const [un, err] = parseUintInternal(s, base, bitSize);
	if (err && err !== errRange) {
		return [0n, err];
	}

	if (bitSize === 0) {
		bitSize = intSize;
	}

	const cutoff = 1n << BigInt(bitSize - 1);
	if (!neg && un >= cutoff) {
		return [cutoff - 1n, errRange];
	}
	if (neg && un > cutoff) {
		return [-cutoff, errRange];
	}
	let n = un;
	if (neg) {
		n = -n;
	}
	return [n, undefined];
}

// Models internal/strconv.underscoreOK.
function underscoreOK(s: string): boolean {
	let saw = "^";
	let i = 0;

	if (s.length >= 1 && (s[0] === "-" || s[0] === "+")) {
		s = s.slice(1);
	}

	let hex = false;
	if (
		s.length >= 2 &&
		s[0] === "0" &&
		(lower(s[1] ?? "") === "b" || lower(s[1] ?? "") === "o" || lower(s[1] ?? "") === "x")
	) {
		i = 2;
		saw = "0";
		hex = lower(s[1] ?? "") === "x";
	}

	for (; i < s.length; i++) {
		const c = s[i] ?? "";
		if (("0" <= c && c <= "9") || (hex && "a" <= lower(c) && lower(c) <= "f")) {
			saw = "0";
			continue;
		}
		if (c === "_") {
			if (saw !== "0") {
				return false;
			}
			saw = "_";
			continue;
		}
		saw = "!";
	}
	return saw !== "_";
}

// Models internal/strconv.lower.
function lower(c: string): string {
	if ("A" <= c && c <= "Z") {
		return c.toLowerCase();
	}
	return c;
}

function toError(fn: string, s: string, base: number, bitSize: number, err: Error): Error {
	switch (err) {
		case errSyntax:
			return syntaxError(fn, s);
		case errRange:
			return rangeError(fn, s);
		case errBase:
			return baseError(fn, s, base);
		case errBitSize:
			return bitSizeError(fn, s, bitSize);
		default:
			return err;
	}
}

function syntaxError(fn: string, str: string): NumError {
	return new NumError(fn, str, errSyntax);
}

function rangeError(fn: string, str: string): NumError {
	return new NumError(fn, str, errRange);
}

function baseError(fn: string, str: string, base: number): NumError {
	return new NumError(fn, str, new Error(`invalid base ${base}`));
}

function bitSizeError(fn: string, str: string, bitSize: number): NumError {
	return new NumError(fn, str, new Error(`invalid bit size ${bitSize}`));
}

function quote(s: string): string {
	let out = '"';
	for (const c of s) {
		switch (c) {
			case "\\":
				out += "\\\\";
				break;
			case '"':
				out += '\\"';
				break;
			case "\0":
				out += "\\x00";
				break;
			default:
				out += c;
				break;
		}
	}
	out += '"';
	return out;
}

const maxUint64 = (1n << 64n) - 1n;
