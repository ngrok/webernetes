import type { DeepPartial } from "./utility-types";

export function deepMerge<T>(base: T, override?: DeepPartial<T>): T {
	return deepMergeUnknown(base, override) as T;
}

export function cloneDeep<T>(value: T): T {
	return cloneDeepUnknown(value) as T;
}

function deepMergeUnknown(base: unknown, override: unknown): unknown {
	if (override === undefined) {
		return cloneDeepUnknown(base);
	}
	if (Array.isArray(base) && Array.isArray(override)) {
		const length = Math.max(base.length, override.length);
		const result: unknown[] = [];
		for (let index = 0; index < length; index++) {
			if (index in override) {
				result[index] = deepMergeUnknown(base[index], override[index]);
			} else {
				result[index] = cloneDeepUnknown(base[index]);
			}
		}
		return result;
	}
	if (Array.isArray(override)) {
		return cloneDeepUnknown(override);
	}
	if (isPlainObject(base) && isPlainObject(override)) {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(base)) {
			result[key] = cloneDeepUnknown(value);
		}
		for (const [key, value] of Object.entries(override)) {
			result[key] = deepMergeUnknown(result[key], value);
		}
		return result;
	}
	return cloneDeepUnknown(override);
}

function cloneDeepUnknown(value: unknown): unknown {
	if (value instanceof Date) {
		return new Date(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => cloneDeepUnknown(item));
	}
	if (isPlainObject(value)) {
		const clone: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			clone[key] = cloneDeepUnknown(item);
		}
		return clone;
	}
	return value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Date) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}
