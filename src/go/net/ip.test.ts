import { expect, it } from "vitest";

import { browser } from "../../test/describe";
import { parseIP } from "./ip";

// Mirrors Go TestParseIP and parseIPTests from:
// https://github.com/golang/go/blob/go1.16.15/src/net/ip_test.go#L15-L57
browser.describe("parseIP", () => {
	const parseIPTests: Array<{ in: string; out: number[] | undefined }> = [
		{ in: "127.0.1.2", out: ipv4(127, 0, 1, 2) },
		{ in: "127.0.0.1", out: ipv4(127, 0, 0, 1) },
		{ in: "127.001.002.003", out: ipv4(127, 1, 2, 3) },
		{ in: "::ffff:127.1.2.3", out: ipv4(127, 1, 2, 3) },
		{ in: "::ffff:127.001.002.003", out: ipv4(127, 1, 2, 3) },
		{ in: "::ffff:7f01:0203", out: ipv4(127, 1, 2, 3) },
		{ in: "0:0:0:0:0000:ffff:127.1.2.3", out: ipv4(127, 1, 2, 3) },
		{ in: "0:0:0:0:000000:ffff:127.1.2.3", out: ipv4(127, 1, 2, 3) },
		{ in: "0:0:0:0::ffff:127.1.2.3", out: ipv4(127, 1, 2, 3) },

		{
			in: "2001:4860:0:2001::68",
			out: ip(0x20, 0x01, 0x48, 0x60, 0, 0, 0x20, 0x01, 0, 0, 0, 0, 0, 0, 0x00, 0x68),
		},
		{
			in: "2001:4860:0000:2001:0000:0000:0000:0068",
			out: ip(0x20, 0x01, 0x48, 0x60, 0, 0, 0x20, 0x01, 0, 0, 0, 0, 0, 0, 0x00, 0x68),
		},

		{ in: "-0.0.0.0", out: undefined },
		{ in: "0.-1.0.0", out: undefined },
		{ in: "0.0.-2.0", out: undefined },
		{ in: "0.0.0.-3", out: undefined },
		{ in: "127.0.0.256", out: undefined },
		{ in: "abc", out: undefined },
		{ in: "123:", out: undefined },
		{ in: "fe80::1%lo0", out: undefined },
		{ in: "fe80::1%911", out: undefined },
		{ in: "", out: undefined },
		{ in: "a1:a2:a3:a4::b1:b2:b3:b4", out: undefined },
	];

	for (const tt of parseIPTests) {
		it(`ParseIP(${JSON.stringify(tt.in)})`, () => {
			expect(parseIP(tt.in)).toEqual(tt.out);
		});
	}
});

function ipv4(a: number, b: number, c: number, d: number): number[] {
	return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, a, b, c, d];
}

function ip(...bytes: number[]): number[] {
	return bytes;
}
