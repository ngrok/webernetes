import { Buffer } from "buffer";
import { CIDR, ipToNumber, numberToIp } from "../../net";
import type * as context from "../../go/context";
import { Etcd } from "../etcd";

function bitmapKey(name: string): string {
	return `/registry/ranges/${name}/bitmap`;
}

function cursorKey(name: string): string {
	return `/registry/ranges/${name}/cursor`;
}

function usedKey(name: string): string {
	return `/registry/ranges/${name}/used`;
}

function lockKey(name: string): string {
	return `/registry/ranges/${name}/lock`;
}

export class AlreadyAllocated extends Error {
	constructor(
		public readonly rangeName: string,
		public readonly index: number,
	) {
		super(`index ${index} is already allocated in range ${rangeName}`);
	}
}

export class NotAllocated extends Error {
	constructor(
		public readonly rangeName: string,
		public readonly index: number,
	) {
		super(`index ${index} is not allocated in range ${rangeName}`);
	}
}

export class AllocatableRange {
	static async create(
		ctx: context.Context,
		etcd: Etcd,
		name: string,
		size: number,
	): Promise<AllocatableRange> {
		const range = AllocatableRange.open(ctx, etcd, name, size);
		await range.reset();
		return range;
	}

	static open(ctx: context.Context, etcd: Etcd, name: string, size: number): AllocatableRange {
		return new AllocatableRange(ctx, etcd, name, size);
	}

	private constructor(
		private readonly ctx: context.Context,
		private readonly etcd: Etcd,
		public readonly name: string,
		public readonly size: number,
	) {}

	private async reset(): Promise<void> {
		const bytes = Math.ceil(this.size / 8);
		await this.etcd.put(bitmapKey(this.name)).value(Buffer.from(new Uint8Array(bytes)));
		await this.etcd.put(cursorKey(this.name)).value("0");
		await this.etcd.put(usedKey(this.name)).value("0");
	}

	private async getCursor(): Promise<number> {
		const c = await this.etcd.get(cursorKey(this.name)).number();
		if (c === null) {
			throw new Error(`cursor not found for range ${this.name}`);
		}
		return c;
	}

	private async getBitmap() {
		const buffer = await this.etcd.get(bitmapKey(this.name)).buffer();
		if (!buffer) {
			throw new Error(`bitmap not found for range ${this.name}`);
		}
		return buffer;
	}

	private async getUsed(): Promise<number> {
		const used = await this.etcd.get(usedKey(this.name)).number();
		if (used === null) {
			throw new Error(`used count not found for range ${this.name}`);
		}
		return used;
	}

	private validateIndex(index: number) {
		if (index < 0 || index >= this.size) {
			throw new Error(`index ${index} out of bounds for range ${this.name}`);
		}
	}

	private getBit(bitmap: Buffer<ArrayBufferLike>, index: number): boolean {
		this.validateIndex(index);
		const byte = Math.floor(index / 8);
		const bit = index % 8;
		return (bitmap[byte] & (1 << bit)) !== 0;
	}

	private setBit(bitmap: Buffer<ArrayBufferLike>, index: number, value: boolean) {
		this.validateIndex(index);
		const byte = Math.floor(index / 8);
		const bit = index % 8;
		if (value) {
			bitmap[byte] |= 1 << bit;
		} else {
			bitmap[byte] &= ~(1 << bit);
		}
	}

	public async allocate(): Promise<number> {
		return await this.etcd.withLock(this.ctx, lockKey(this.name), { timeoutMs: 5000 }, async () => {
			const cursor = await this.getCursor();
			const used = await this.getUsed();
			if (used >= this.size) {
				throw new Error(`no free space in range ${this.name}`);
			}
			const bitmap = await this.getBitmap();
			for (let offset = 0; offset < this.size; offset++) {
				const i = (cursor + offset) % this.size;
				if (!this.getBit(bitmap, i)) {
					this.setBit(bitmap, i, true);
					await this.etcd.put(bitmapKey(this.name)).value(bitmap);
					await this.etcd.put(cursorKey(this.name)).value((i + 1) % this.size);
					await this.etcd.put(usedKey(this.name)).value(used + 1);
					return i;
				}
			}
			throw new Error(`no free space in range ${this.name}`);
		});
	}

	public async claim(index: number): Promise<void> {
		this.validateIndex(index);
		await this.etcd.withLock(this.ctx, lockKey(this.name), { timeoutMs: 5000 }, async () => {
			const bitmap = await this.getBitmap();
			if (this.getBit(bitmap, index)) {
				throw new AlreadyAllocated(this.name, index);
			}
			const used = await this.getUsed();
			this.setBit(bitmap, index, true);
			await this.etcd.put(bitmapKey(this.name)).value(bitmap);
			await this.etcd.put(usedKey(this.name)).value(used + 1);
		});
	}

	public async release(index: number): Promise<void> {
		this.validateIndex(index);
		await this.etcd.withLock(this.ctx, lockKey(this.name), { timeoutMs: 5000 }, async () => {
			const bitmap = await this.getBitmap();
			if (!this.getBit(bitmap, index)) {
				throw new NotAllocated(this.name, index);
			}
			const used = await this.getUsed();
			this.setBit(bitmap, index, false);
			await this.etcd.put(bitmapKey(this.name)).value(bitmap);
			await this.etcd.put(usedKey(this.name)).value(Math.max(0, used - 1));
		});
	}

	public async has(index: number): Promise<boolean> {
		this.validateIndex(index);
		return await this.etcd.withLock(this.ctx, lockKey(this.name), { timeoutMs: 5000 }, async () => {
			const bitmap = await this.getBitmap();
			return this.getBit(bitmap, index);
		});
	}
}

export class PortRange {
	private readonly range: AllocatableRange;
	private readonly from: number;
	private readonly to: number;

	static async create(
		ctx: context.Context,
		etcd: Etcd,
		name: string,
		from: number,
		to: number,
	): Promise<PortRange> {
		const range = await AllocatableRange.create(ctx, etcd, name, to - from + 1);
		return new PortRange(range, from, to);
	}

	static open(ctx: context.Context, etcd: Etcd, name: string, from: number, to: number): PortRange {
		return new PortRange(AllocatableRange.open(ctx, etcd, name, to - from + 1), from, to);
	}

	private constructor(range: AllocatableRange, from: number, to: number) {
		this.range = range;
		this.from = from;
		this.to = to;
	}

	private validatePort(index: number) {
		if (index < this.from || index > this.to) {
			throw new Error(`invalid port ${index} for range ${this.range.name}`);
		}
	}

	public async allocate(): Promise<number> {
		const index = await this.range.allocate();
		return this.from + index;
	}

	public async claim(port: number): Promise<void> {
		this.validatePort(port);
		try {
			await this.range.claim(port - this.from);
		} catch (error) {
			if (error instanceof AlreadyAllocated) {
				throw new Error(`port ${port} is already allocated in range ${this.range.name}`, {
					cause: error,
				});
			}
			throw error;
		}
	}

	public async release(port: number): Promise<void> {
		this.validatePort(port);
		try {
			await this.range.release(port - this.from);
		} catch (error) {
			if (error instanceof NotAllocated) {
				throw new Error(`invalid port ${port} for range ${this.range.name}`, { cause: error });
			}
			throw error;
		}
	}

	public async has(port: number): Promise<boolean> {
		this.validatePort(port);
		return await this.range.has(port - this.from);
	}
}

export class IpRange {
	private readonly range: AllocatableRange;
	private readonly cidr: CIDR;

	static async create(
		ctx: context.Context,
		etcd: Etcd,
		name: string,
		cidrStr: string,
	): Promise<IpRange> {
		const cidr = new CIDR(cidrStr);
		const range = await AllocatableRange.create(ctx, etcd, name, cidr.last - cidr.first + 1);
		return new IpRange(range, cidr);
	}

	static open(ctx: context.Context, etcd: Etcd, name: string, cidrStr: string): IpRange {
		const cidr = new CIDR(cidrStr);
		return new IpRange(AllocatableRange.open(ctx, etcd, name, cidr.last - cidr.first + 1), cidr);
	}

	private constructor(range: AllocatableRange, cidr: CIDR) {
		this.range = range;
		this.cidr = cidr;
	}

	private validateIp(ip: string) {
		if (!this.cidr.containsUsableAddress(ip)) {
			throw new Error(`invalid ip ${ip} for range ${this.range.name}`);
		}
	}

	public contains(ip: string): boolean {
		return this.cidr.containsUsableAddress(ip);
	}

	private indexForIp(ip: string): number {
		this.validateIp(ip);
		const num = ipToNumber(ip);
		if (num === undefined) {
			throw new Error(`invalid ip ${ip} for range ${this.range.name}`);
		}
		return num - this.cidr.first;
	}

	public async allocate(): Promise<string> {
		const index = await this.range.allocate();
		return numberToIp(this.cidr.first + index);
	}

	public async claim(ip: string): Promise<void> {
		try {
			await this.range.claim(this.indexForIp(ip));
		} catch (error) {
			if (error instanceof AlreadyAllocated) {
				throw new Error(`ip ${ip} is already allocated in range ${this.range.name}`, {
					cause: error,
				});
			}
			throw error;
		}
	}

	public async release(ip: string): Promise<void> {
		try {
			await this.range.release(this.indexForIp(ip));
		} catch (error) {
			if (error instanceof NotAllocated) {
				throw new Error(`invalid ip ${ip} for range ${this.range.name}`, { cause: error });
			}
			throw error;
		}
	}

	public async has(ip: string): Promise<boolean> {
		return await this.range.has(this.indexForIp(ip));
	}
}
