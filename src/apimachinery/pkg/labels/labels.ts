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

	// Models staging/src/k8s.io/apimachinery/pkg/labels/labels.go Set.String.
	string(): string {
		const selector: string[] = [];
		for (const [key, value] of this.entries()) {
			selector.push(`${key}=${value}`);
		}
		selector.sort();
		return selector.join(",");
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/labels.go Set.Has.
	has(label: string): boolean {
		return super.has(label);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/labels.go Set.Get.
	get(label: string): string {
		return super.get(label) ?? "";
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/labels.go Set.Lookup.
	lookup(label: string): [value: string, exists: boolean] {
		const val = super.get(label) ?? "";
		const exists = super.has(label);
		return [val, exists];
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/labels.go Set.AsSelector.
	asSelector(): Selector {
		return selectorFromSet(this);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/labels.go Set.AsValidatedSelector.
	asValidatedSelector(): [selector: Selector | undefined, err: Error | undefined] {
		return validatedSelectorFromSet(this);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/labels.go Set.AsSelectorPreValidated.
	asSelectorPreValidated(): Selector {
		return selectorFromValidatedSet(this);
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/labels.go FormatLabels.
export function formatLabels(labelMap: Record<string, string>): string {
	let l = new Set(labelMap).string();
	if (l === "") {
		l = "<none>";
	}
	return l;
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
		const val = big.get(k);
		const match = big.has(k);
		if (match) {
			if (val !== v) {
				return true;
			}
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
		const value = labels2.get(k);
		const ok = labels2.has(k);
		if (!ok) {
			return false;
		}
		if (value !== v) {
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
	const labels = selector.split(",");
	for (const label of labels) {
		const l = label.split("=");
		if (l.length !== 2) {
			return [labelsMap, new Error(`invalid selector: [${l.join(" ")}]`)];
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
