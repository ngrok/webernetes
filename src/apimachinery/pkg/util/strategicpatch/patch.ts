// Models kubernetes/staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch.go JSONMap.
export type JSONMap = Record<string, unknown>;

const directiveMarker = "$patch";
const deleteDirective = "delete";
const deleteFromPrimitiveListDirectivePrefix = "$deleteFromPrimitiveList";

// Models kubernetes/staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch.go StrategicMergePatch.
// Incomplete local shim: this only supports the pod metadata strategic merge
// behavior needed by controller adoption/release. TODO: port the rest of the
// upstream strategic merge patch machinery.
export function strategicMergePatch<T extends object>(
	original: T,
	patch: unknown,
	_dataStruct?: unknown,
): T {
	if (!isJSONMap(patch)) {
		throw new Error("Strategic merge patch body must be an object");
	}
	return strategicMergeMapPatch(structuredClone(original) as JSONMap, patch) as T;
}

// Models kubernetes/staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch.go StrategicMergeMapPatch.
// Incomplete local shim: this currently delegates to a narrowed mergeMap that
// only knows the patch metadata required by pod ownerReferences/finalizers.
// TODO: port schema-backed LookupPatchMeta support and full list semantics.
export function strategicMergeMapPatch(
	original: JSONMap,
	patch: JSONMap,
	_dataStruct?: unknown,
): JSONMap {
	return mergeMap(original, patch);
}

// Models kubernetes/staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch.go mergeMap.
// Incomplete local shim: this implements JSON merge patch plus the small
// strategic subset used by ReplicaSet pod adoption/release patches.
function mergeMap(original: JSONMap, patch: JSONMap, path: string[] = []): JSONMap {
	for (const [key, patchV] of Object.entries(patch)) {
		if (key.startsWith(deleteFromPrimitiveListDirectivePrefix)) {
			const originalKey = extractKey(key, deleteFromPrimitiveListDirectivePrefix);
			const originalV = original[originalKey];
			if (Array.isArray(originalV) && Array.isArray(patchV)) {
				original[originalKey] = deleteFromSlice(originalV, patchV);
			}
			continue;
		}

		if (patchV === null) {
			delete original[key];
			continue;
		}

		const originalV = original[key];
		if (isJSONMap(originalV) && isJSONMap(patchV)) {
			original[key] = mergeMap(originalV, patchV, [...path, key]);
			continue;
		}

		if (Array.isArray(originalV) && Array.isArray(patchV)) {
			const mergeKey = patchMergeKeyForPath([...path, key]);
			original[key] = mergeKey
				? mergeSlice(originalV, patchV, mergeKey, [...path, key])
				: structuredClone(patchV);
			continue;
		}

		original[key] = structuredClone(patchV);
	}
	return original;
}

// Models kubernetes/staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch.go mergeSlice.
// Incomplete local shim: only map slices with a known local merge key are
// merged. Other list semantics still need the full upstream implementation.
function mergeSlice(
	original: unknown[],
	patch: unknown[],
	mergeKey: string,
	path: string[],
): unknown[] {
	if (!canMergeMapSlice(original) || !canMergeMapSlice(patch)) {
		return structuredClone(patch);
	}
	const [originalWithoutSpecialElements, patchWithoutSpecialElements] =
		mergeSliceWithSpecialElements(original, patch, mergeKey);
	if (!patchWithoutSpecialElements) {
		return originalWithoutSpecialElements;
	}
	return mergeSliceWithoutSpecialElements(
		originalWithoutSpecialElements,
		patchWithoutSpecialElements,
		mergeKey,
		path,
	);
}

// Models kubernetes/staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch.go mergeSliceWithSpecialElements.
// Incomplete local shim: currently supports only `$patch: "delete"` entries.
// TODO: add replace/merge directive behavior with upstream error handling.
function mergeSliceWithSpecialElements(
	original: JSONMap[],
	patch: JSONMap[],
	mergeKey: string,
): [JSONMap[], JSONMap[] | undefined] {
	const patchWithoutSpecialElements: JSONMap[] = [];
	for (const v of patch) {
		const patchType = v[directiveMarker];
		if (patchType === undefined) {
			patchWithoutSpecialElements.push(v);
			continue;
		}
		if (patchType === deleteDirective) {
			const mergeValue = v[mergeKey];
			if (mergeValue !== undefined) {
				original = deleteMatchingEntries(original, mergeKey, mergeValue);
			}
		}
	}
	return [original, patchWithoutSpecialElements];
}

// Models kubernetes/staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch.go mergeSliceWithoutSpecialElements.
// Incomplete local shim: recursively merges matching map entries but omits
// schema validation, ordering directives, and conflict/error parity.
function mergeSliceWithoutSpecialElements(
	original: JSONMap[],
	patch: JSONMap[],
	mergeKey: string,
	path: string[],
): JSONMap[] {
	for (const v of patch) {
		const mergeValue = v[mergeKey];
		if (mergeValue === undefined) {
			continue;
		}
		const [originalMap, originalKey, found] = findMapInSliceBasedOnKeyValue(
			original,
			mergeKey,
			mergeValue,
		);
		if (found) {
			original[originalKey] = mergeMap(originalMap, v, path);
		} else {
			original.push(structuredClone(v));
		}
	}
	return original;
}

// Models kubernetes/staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch.go deleteMatchingEntries.
// Incomplete local shim: local callers only need equality on primitive merge
// key values.
function deleteMatchingEntries(
	original: JSONMap[],
	mergeKey: string,
	mergeValue: unknown,
): JSONMap[] {
	for (;;) {
		const [, originalKey, found] = findMapInSliceBasedOnKeyValue(original, mergeKey, mergeValue);
		if (!found) {
			break;
		}
		original.splice(originalKey, 1);
	}
	return original;
}

// Models kubernetes/staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch.go findMapInSliceBasedOnKeyValue.
// Incomplete local shim: returns tuple state rather than upstream errors until
// the full strategicpatch package is ported.
function findMapInSliceBasedOnKeyValue(
	original: JSONMap[],
	mergeKey: string,
	mergeValue: unknown,
): [JSONMap, number, boolean] {
	const originalKey = original.findIndex((item) => item[mergeKey] === mergeValue);
	if (originalKey < 0) {
		return [{}, -1, false];
	}
	return [original[originalKey] ?? {}, originalKey, true];
}

// Models kubernetes/staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch.go deleteFromSlice.
// Incomplete local shim: this handles the primitive list deletion directive
// required for pod finalizers.
function deleteFromSlice(original: unknown[], patch: unknown[]): unknown[] {
	const deleteSet = new Set(patch);
	return original.filter((item) => !deleteSet.has(item));
}

// Models kubernetes/staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch.go extractKey.
// Incomplete local shim: upstream returns typed errors; this throws only for
// malformed local directive keys.
function extractKey(s: string, prefix: string): string {
	const [actualPrefix, key] = s.split("/", 2);
	if (actualPrefix !== prefix || key === undefined) {
		throw new Error(`failed to find prefix ${prefix} in ${s}`);
	}
	return key;
}

function patchMergeKeyForPath(path: string[]): string | undefined {
	return path.join(".") === "metadata.ownerReferences" ? "uid" : undefined;
}

function canMergeMapSlice(value: unknown[]): value is JSONMap[] {
	return value.every(isJSONMap);
}

function isJSONMap(value: unknown): value is JSONMap {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
