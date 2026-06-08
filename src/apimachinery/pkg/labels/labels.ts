import {
	type Selector,
	selectorFromSet,
	selectorFromValidatedSet,
	validatedSelectorFromSet,
	validateLabelKey,
	validateLabelValue,
} from "./selector";
import { type PathOption, toPath } from "../util/validation/field/path";

// Models staging/src/k8s.io/apimachinery/pkg/labels/labels.go Labels.
export interface Labels {
	has(label: string): boolean;
	get(label: string): string;
	lookup(label: string): [value: string, exists: boolean];
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/labels.go Set.
export class Set extends Map<string, string> implements Labels {
	constructor(labels: Record<string, string> | Map<string, string> | undefined = {}) {
		super(labels instanceof Map ? labels : Object.entries(labels ?? {}));
	}

	string(): string {
		return Array.from(this.entries())
			.map(([key, value]) => `${key}=${value}`)
			.sort()
			.join(",");
	}

	get(label: string): string {
		return super.get(label) ?? "";
	}

	lookup(label: string): [value: string, exists: boolean] {
		if (!this.has(label)) {
			return ["", false];
		}
		return [this.get(label), true];
	}

	asSelector(): Selector {
		return selectorFromSet(this);
	}

	asValidatedSelector(): [selector: Selector | undefined, err: Error | undefined] {
		return validatedSelectorFromSet(this);
	}

	asSelectorPreValidated(): Selector {
		return selectorFromValidatedSet(this);
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/labels.go FormatLabels.
export function formatLabels(labelMap: Record<string, string>): string {
	const formatted = new Set(labelMap).string();
	return formatted === "" ? "<none>" : formatted;
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/labels.go Conflicts.
export function conflicts(labels1: Set, labels2: Set): boolean {
	let small = labels1;
	let big = labels2;
	if (big.size < small.size) {
		small = labels2;
		big = labels1;
	}
	for (const [k, v] of small.entries()) {
		if (big.has(k) && big.get(k) !== v) {
			return true;
		}
	}
	return false;
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/labels.go Merge.
export function merge(labels1: Set, labels2: Set): Set {
	const mergedMap = new Set();

	for (const [k, v] of labels1.entries()) {
		mergedMap.set(k, v);
	}
	for (const [k, v] of labels2.entries()) {
		mergedMap.set(k, v);
	}
	return mergedMap;
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/labels.go Equals.
export function equals(labels1: Set, labels2: Set): boolean {
	if (labels1.size !== labels2.size) {
		return false;
	}
	for (const [k, v] of labels1.entries()) {
		if (!labels2.has(k) || labels2.get(k) !== v) {
			return false;
		}
	}
	return true;
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/labels.go ConvertSelectorToLabelsMap.
export function convertSelectorToLabelsMap(
	selector: string,
	...opts: PathOption[]
): [labels: Set, err: Error | undefined] {
	const labelsMap = new Set();
	if (selector.length === 0) {
		return [labelsMap, undefined];
	}
	for (const label of selector.split(",")) {
		const l = label.split("=");
		if (l.length !== 2) {
			return [labelsMap, new Error(`invalid selector: ${l.join(",")}`)];
		}
		const key = (l[0] ?? "").trim();
		const keyErr = validateLabelKey(key, toPath(...opts));
		if (keyErr) {
			return [labelsMap, keyErr];
		}
		const value = (l[1] ?? "").trim();
		const valueErr = validateLabelValue(key, value, toPath(...opts));
		if (valueErr) {
			return [labelsMap, valueErr];
		}
		labelsMap.set(key, value);
	}
	return [labelsMap, undefined];
}
