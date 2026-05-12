export const PatchStrategy = {
	JsonPatch: "application/json-patch+json",
	MergePatch: "application/merge-patch+json",
	StrategicMergePatch: "application/strategic-merge-patch+json",
	ServerSideApply: "application/apply-patch+yaml",
} as const;

export type PatchStrategy = (typeof PatchStrategy)[keyof typeof PatchStrategy];

export interface HeaderOptions {
	middleware?: unknown[];
	middlewareMergeStrategy?: "replace" | "append" | "prepend";
	[key: string]: unknown;
}

export function setHeaderOptions(
	key: string,
	value: string,
	options: HeaderOptions = {},
): HeaderOptions {
	return {
		...options,
		headers: {
			...(isRecord(options.headers) ? options.headers : {}),
			[key]: value,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
