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
