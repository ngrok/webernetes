export class SortedMap<K, V> {
	private readonly items: Array<[K, V]> = [];

	constructor(
		private readonly compareKeys: (left: K, right: K) => number,
		entries?: Iterable<readonly [K, V]>,
	) {
		if (entries) {
			for (const [key, value] of entries) {
				this.set(key, value);
			}
		}
	}

	public get size(): number {
		return this.items.length;
	}

	public at(index: number): readonly [K, V] | undefined {
		return this.items[index];
	}

	public set(key: K, value: V): V | undefined {
		const index = this.lowerBound(key);
		const existing = this.items[index];
		if (existing !== undefined && this.compareKeys(existing[0], key) === 0) {
			this.items[index] = [key, value];
			return existing[1];
		}

		this.items.splice(index, 0, [key, value]);
		return undefined;
	}

	public get(key: K): V | undefined {
		const index = this.lowerBound(key);
		const existing = this.items[index];
		if (existing !== undefined && this.compareKeys(existing[0], key) === 0) {
			return existing[1];
		}
		return undefined;
	}

	public delete(key: K): V | undefined {
		const index = this.lowerBound(key);
		const existing = this.items[index];
		if (existing === undefined || this.compareKeys(existing[0], key) !== 0) {
			return undefined;
		}

		this.items.splice(index, 1);
		return existing[1];
	}

	public clearBefore(key: K): number {
		const count = this.lowerBound(key);
		if (count > 0) {
			this.items.splice(0, count);
		}
		return count;
	}

	public *entries(): Generator<readonly [K, V]> {
		yield* this.items;
	}

	public *entriesFrom(key: K): Generator<readonly [K, V]> {
		for (let index = this.lowerBound(key); index < this.items.length; index += 1) {
			const item = this.items[index];
			if (item !== undefined) {
				yield item;
			}
		}
	}

	public *values(): Generator<V> {
		for (const [, value] of this.items) {
			yield value;
		}
	}

	public clone(cloneValue?: (value: V, key: K) => V): SortedMap<K, V> {
		return new SortedMap(
			this.compareKeys,
			this.items.map(([key, value]) => [key, cloneValue ? cloneValue(value, key) : value] as const),
		);
	}

	private lowerBound(key: K): number {
		let low = 0;
		let high = this.items.length;

		while (low < high) {
			const mid = Math.floor((low + high) / 2);
			const item = this.items[mid];
			if (item === undefined) {
				break;
			}

			if (this.compareKeys(item[0], key) < 0) {
				low = mid + 1;
			} else {
				high = mid;
			}
		}

		return low;
	}
}

export class KeyFnMap<K, V> implements Iterable<[K, V]> {
	private readonly items = new Map<string, { key: K; value: V }>();

	constructor(
		private readonly keyString: (key: K) => string = stableJSONStringify,
		entries?: Iterable<readonly [K, V]>,
		private readonly cloneKey: (key: K) => K = (key) => structuredClone(key),
	) {
		for (const [key, value] of entries || []) {
			this.set(key, value);
		}
	}

	get size(): number {
		return this.items.size;
	}

	has(key: K): boolean {
		return this.items.has(this.keyString(key));
	}

	get(key: K): V | undefined {
		return this.items.get(this.keyString(key))?.value;
	}

	set(key: K, value: V): this {
		this.items.set(this.keyString(key), { key: this.cloneKey(key), value });
		return this;
	}

	delete(key: K): boolean {
		return this.items.delete(this.keyString(key));
	}

	clear(): void {
		this.items.clear();
	}

	*keys(): IterableIterator<K> {
		for (const { key } of this.items.values()) {
			yield this.cloneKey(key);
		}
	}

	*values(): IterableIterator<V> {
		for (const { value } of this.items.values()) {
			yield value;
		}
	}

	*entries(): IterableIterator<[K, V]> {
		for (const { key, value } of this.items.values()) {
			yield [this.cloneKey(key), value];
		}
	}

	[Symbol.iterator](): IterableIterator<[K, V]> {
		return this.entries();
	}
}

function stableJSONStringify(value: unknown): string {
	return JSON.stringify(sortJSONValue(value));
}

function sortJSONValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortJSONValue);
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.toSorted(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, sortJSONValue(item)]),
		);
	}
	return value;
}
