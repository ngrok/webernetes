import type { Fnv32a } from "../../fnv";

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue | undefined };

// Models kubernetes/pkg/util/hash/hash.go DeepHashObject.
export function deepHashObject(
	hasher: Fnv32a,
	objectToWrite: string | Uint8Array | readonly number[],
): void {
	hasher.reset();
	hasher.write(dumpForHash(objectToWrite));
}

export { deepHashObject as DeepHashObject };

export function jsonMarshal(value: JsonValue): Uint8Array {
	return new TextEncoder().encode(stableJsonStringify(value));
}

function stableJsonStringify(value: JsonValue | undefined): string {
	if (value === undefined) {
		return "null";
	}
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
	}

	const entries = Object.entries(value)
		.filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries
		.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`)
		.join(",")}}`;
}

function dumpForHash(objectToWrite: string | Uint8Array | readonly number[]): string {
	if (typeof objectToWrite === "string") {
		return objectToWrite;
	}
	return `([]uint8)[${[...objectToWrite].join(" ")}]`;
}
