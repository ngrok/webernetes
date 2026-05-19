export class Fnv32a {
	private value = 0x811c9dc5;

	public reset() {
		this.value = 0x811c9dc5;
	}

	public write(data: string | Uint8Array | readonly number[]) {
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		for (const byte of bytes) {
			this.value ^= byte;
			this.value = Math.imul(this.value, 0x01000193) >>> 0;
		}
	}

	public sum32(): number {
		return this.value;
	}
}

export function new32a(): Fnv32a {
	return new Fnv32a();
}
