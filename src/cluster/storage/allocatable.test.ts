import { expect, it } from "vitest";

import type * as context from "../../go/context";
import { browser } from "../../test/describe";
import { Etcd } from "../etcd";
import {
	AllocatableRange,
	AlreadyAllocated,
	IpRange,
	NotAllocated,
	PortRange,
} from "./allocatable";

browser.describe("AllocatableRange", ({ ctx }) => {
	it("throws an AlreadyAllocated error with the claimed index", async () => {
		const range = await AllocatableRange.create(ctx, newTestEtcd(ctx), "raw", 2);
		await range.claim(1);

		await expect(range.claim(1)).rejects.toMatchObject({
			index: 1,
			rangeName: "raw",
		});
		await expect(range.claim(1)).rejects.toBeInstanceOf(AlreadyAllocated);
	});

	it("throws a NotAllocated error with the released index", async () => {
		const range = await AllocatableRange.create(ctx, newTestEtcd(ctx), "raw", 2);

		await expect(range.release(1)).rejects.toMatchObject({
			index: 1,
			rangeName: "raw",
		});
		await expect(range.release(1)).rejects.toBeInstanceOf(NotAllocated);
	});
});

browser.describe("PortRange", ({ ctx }) => {
	it("allocates ports in order and throws when exhausted", async () => {
		const range = await createPortRange(ctx, 30000, 30002);

		await expect(range.allocate()).resolves.toBe(30000);
		await expect(range.allocate()).resolves.toBe(30001);
		await expect(range.allocate()).resolves.toBe(30002);
		await expect(range.allocate()).rejects.toThrow("no free space in range ports");
	});

	it("returns released ports to the pool and wraps around from the cursor", async () => {
		const range = await createPortRange(ctx, 30000, 30002);

		expect(await range.allocate()).toBe(30000);
		expect(await range.allocate()).toBe(30001);
		expect(await range.allocate()).toBe(30002);

		await range.release(30000);
		expect(await range.allocate()).toBe(30000);

		await range.release(30002);
		expect(await range.allocate()).toBe(30002);
	});

	it("rejects invalid and duplicate releases", async () => {
		const range = await createPortRange(ctx, 30000, 30001);

		await expect(range.release(29999)).rejects.toThrow("invalid port 29999 for range ports");
		await expect(range.release(30000)).rejects.toThrow("invalid port 30000 for range ports");

		expect(await range.allocate()).toBe(30000);
		await range.release(30000);
		await expect(range.release(30000)).rejects.toThrow("invalid port 30000 for range ports");
	});

	it("claims explicit ports and skips them during allocation", async () => {
		const range = await createPortRange(ctx, 30000, 30002);

		await range.claim(30001);

		expect(await range.has(30001)).toBe(true);
		await expect(range.claim(30001)).rejects.toThrow("already allocated");
		expect(await range.allocate()).toBe(30000);
		expect(await range.allocate()).toBe(30002);
		await expect(range.allocate()).rejects.toThrow("no free space in range ports");
	});

	it("opens an initialized port range without resetting allocations", async () => {
		const etcd = newTestEtcd(ctx);
		const created = await PortRange.create(ctx, etcd, "ports", 30000, 30002);
		await created.claim(30001);

		const opened = PortRange.open(ctx, etcd, "ports", 30000, 30002);

		expect(await opened.has(30001)).toBe(true);
		expect(await opened.allocate()).toBe(30000);
		expect(await opened.allocate()).toBe(30002);
	});

	it("serializes concurrent port allocations", async () => {
		const range = await createPortRange(ctx, 30000, 30019);

		const ports = await Promise.all(Array.from({ length: 20 }, () => range.allocate()));

		expect(new Set(ports).size).toBe(20);
		expect(ports.toSorted((left, right) => left - right)).toEqual(
			Array.from({ length: 20 }, (_, index) => 30000 + index),
		);
	});
});

browser.describe("IpRange", ({ ctx }) => {
	it("allocates usable addresses from a CIDR range and throws when exhausted", async () => {
		const range = await createIpRange(ctx, "10.0.0.0/30");

		await expect(range.allocate()).resolves.toBe("10.0.0.1");
		await expect(range.allocate()).resolves.toBe("10.0.0.2");
		await expect(range.allocate()).rejects.toThrow("no free space in range ips");
	});

	it("returns released addresses to the pool and wraps around from the cursor", async () => {
		const range = await createIpRange(ctx, "10.0.0.0/30");

		expect(await range.allocate()).toBe("10.0.0.1");
		expect(await range.allocate()).toBe("10.0.0.2");

		await range.release("10.0.0.1");
		expect(await range.allocate()).toBe("10.0.0.1");
	});

	it("rejects invalid and duplicate IP releases", async () => {
		const range = await createIpRange(ctx, "10.0.0.0/30");

		await expect(range.release("10.0.0.3")).rejects.toThrow("invalid ip 10.0.0.3 for range ips");
		await expect(range.release("10.0.0.1")).rejects.toThrow("invalid ip 10.0.0.1 for range ips");

		expect(await range.allocate()).toBe("10.0.0.1");
		await range.release("10.0.0.1");
		await expect(range.release("10.0.0.1")).rejects.toThrow("invalid ip 10.0.0.1 for range ips");
	});

	it("claims explicit IPs and skips them during allocation", async () => {
		const range = await createIpRange(ctx, "10.0.0.0/30");

		await range.claim("10.0.0.2");

		expect(await range.has("10.0.0.2")).toBe(true);
		await expect(range.claim("10.0.0.2")).rejects.toThrow("already allocated");
		expect(await range.allocate()).toBe("10.0.0.1");
		await expect(range.allocate()).rejects.toThrow("no free space in range ips");
	});

	it("opens an initialized IP range without resetting allocations", async () => {
		const etcd = newTestEtcd(ctx);
		const created = await IpRange.create(ctx, etcd, "ips", "10.0.0.0/30");
		await created.claim("10.0.0.2");

		const opened = IpRange.open(ctx, etcd, "ips", "10.0.0.0/30");

		expect(opened.contains("10.0.0.1")).toBe(true);
		expect(await opened.has("10.0.0.2")).toBe(true);
		expect(await opened.allocate()).toBe("10.0.0.1");
	});

	it("serializes concurrent IP allocations", async () => {
		const range = await createIpRange(ctx, "10.0.0.0/27");

		const ips = await Promise.all(Array.from({ length: 30 }, () => range.allocate()));

		expect(new Set(ips).size).toBe(30);
		expect(ips.toSorted(compareIp)).toEqual(
			Array.from({ length: 30 }, (_, index) => `10.0.0.${index + 1}`),
		);
	});
});

async function createPortRange(ctx: context.Context, from: number, to: number): Promise<PortRange> {
	return await PortRange.create(ctx, newTestEtcd(ctx), "ports", from, to);
}

async function createIpRange(ctx: context.Context, cidr: string): Promise<IpRange> {
	return await IpRange.create(ctx, newTestEtcd(ctx), "ips", cidr);
}

function newTestEtcd(ctx: context.Context): Etcd {
	return new Etcd(ctx);
}

function compareIp(left: string, right: string): number {
	return ipValue(left) - ipValue(right);
}

function ipValue(ip: string): number {
	return ip.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}
