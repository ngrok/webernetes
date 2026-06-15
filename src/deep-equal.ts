export interface DeepEqualOptions {
	ignoredFields?: readonly string[];
	ignoreUndefined?: boolean;
}

export function deepEqual(left: unknown, right: unknown, opts: DeepEqualOptions = {}): boolean {
	return deepEqualAtPath(
		left,
		right,
		{
			ignoredFields: new Set(opts.ignoredFields ?? []),
			ignoreUndefined: opts.ignoreUndefined === true,
		},
		"",
	);
}

interface DeepEqualContext {
	ignoredFields: ReadonlySet<string>;
	ignoreUndefined: boolean;
}

function deepEqualAtPath(
	left: unknown,
	right: unknown,
	context: DeepEqualContext,
	path: string,
): boolean {
	if (context.ignoredFields.has(path)) {
		return true;
	}
	if (left === right) {
		return true;
	}
	if (left instanceof Date || right instanceof Date) {
		return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
			return false;
		}
		return left.every((value, index) =>
			deepEqualAtPath(value, right[index], context, childPath(path, String(index))),
		);
	}
	if (isPlainObject(left) || isPlainObject(right)) {
		if (!isPlainObject(left) || !isPlainObject(right)) {
			return false;
		}
		const leftKeys = comparableKeys(left, context, path);
		const rightKeys = comparableKeys(right, context, path);
		return (
			leftKeys.length === rightKeys.length &&
			leftKeys.every(
				(key) =>
					key in right && deepEqualAtPath(left[key], right[key], context, childPath(path, key)),
			)
		);
	}
	return false;
}

export function dropUndefinedFields<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((item) => dropUndefinedFields(item)) as T;
	}
	if (value instanceof Date || typeof value !== "object" || value === null) {
		return value;
	}
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) {
			result[key] = dropUndefinedFields(item);
		}
	}
	return result as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function comparableKeys(
	value: Record<string, unknown>,
	context: DeepEqualContext,
	path: string,
): string[] {
	return Object.keys(value).filter(
		(key) =>
			!context.ignoredFields.has(childPath(path, key)) &&
			(!context.ignoreUndefined || value[key] !== undefined),
	);
}

function childPath(parent: string, key: string): string {
	return parent === "" ? key : `${parent}.${key}`;
}
