import { expect, it } from "vitest";

import { browser } from "./test/describe";
import { CIDR, isIPLiteral } from "./net";

browser.describe("CIDR", () => {
	it("checks full IPv4 CIDR membership separately from usable host membership", () => {
		const cidr = new CIDR("10.0.0.0/30");

		expect(cidr.contains("10.0.0.0")).toBe(true);
		expect(cidr.contains("10.0.0.1")).toBe(true);
		expect(cidr.contains("10.0.0.2")).toBe(true);
		expect(cidr.contains("10.0.0.3")).toBe(true);
		expect(cidr.contains("10.0.0.4")).toBe(false);

		expect(cidr.containsUsableAddress("10.0.0.0")).toBe(false);
		expect(cidr.containsUsableAddress("10.0.0.1")).toBe(true);
		expect(cidr.containsUsableAddress("10.0.0.2")).toBe(true);
		expect(cidr.containsUsableAddress("10.0.0.3")).toBe(false);
	});

	it("keeps IPv4 allocation helpers on usable addresses", () => {
		const cidr = new CIDR("10.0.0.0/30");

		expect(cidr.first).toBe(0x0a000001);
		expect(cidr.last).toBe(0x0a000002);
		expect(cidr.firstAddress()).toBe("10.0.0.1");
		expect(cidr.addressAfter("10.0.0.1")).toBe("10.0.0.2");
		expect(cidr.addressAfter("10.0.0.2")).toBeUndefined();
		expect([...cidr.addresses()]).toEqual(["10.0.0.1", "10.0.0.2"]);
	});

	it("checks IPv6 CIDR membership", () => {
		const uniqueLocal = new CIDR("fc00::/7");
		const linkLocal = new CIDR("fe80::/10");

		expect(uniqueLocal.contains("fc00::")).toBe(true);
		expect(uniqueLocal.contains("fd12:3456::1")).toBe(true);
		expect(uniqueLocal.contains("[fd12:3456::1]")).toBe(true);
		expect(uniqueLocal.contains("fe80::1")).toBe(false);

		expect(linkLocal.contains("fe80::1")).toBe(true);
		expect(linkLocal.contains("febf:ffff::1")).toBe(true);
		expect(linkLocal.contains("fec0::1")).toBe(false);
	});

	it("supports IPv6 address iteration for small ranges", () => {
		const cidr = new CIDR("2001:db8::/126");

		expect(cidr.firstAddress()).toBe("2001:db8::");
		expect(cidr.addressAfter("2001:db8::")).toBe("2001:db8::1");
		expect([...cidr.addresses()]).toEqual([
			"2001:db8::",
			"2001:db8::1",
			"2001:db8::2",
			"2001:db8::3",
		]);
		expect(() => cidr.first).toThrow("CIDR numeric bounds are only available for IPv4 ranges");
	});

	it("validates IP literals", () => {
		expect(isIPLiteral("192.168.1.1")).toBe(true);
		expect(isIPLiteral("[fd12:3456::1]")).toBe(true);
		expect(isIPLiteral("example.com")).toBe(false);
	});
});
