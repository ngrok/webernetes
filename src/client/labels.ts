import { Set } from "../apimachinery/pkg/labels/labels";
import { parse, type Selector } from "../apimachinery/pkg/labels/selector";
import type { KubernetesObject } from "./types";

export type LabelSelector = Selector;

export function parseLabelSelector(selector?: string): LabelSelector {
	const [labelSelector, err] = parse(selector ?? "");
	if (err) {
		throw err;
	}
	if (!labelSelector) {
		throw new Error(`invalid selector: ${selector ?? ""}`);
	}
	return labelSelector;
}

export function labelsMatch(obj: KubernetesObject, selector: LabelSelector): boolean {
	return selector.matches(new Set(obj.metadata?.labels ?? {}));
}

export function filterByLabels<T extends KubernetesObject>(
	objects: T[],
	selector: LabelSelector,
): T[] {
	return objects.filter((obj) => labelsMatch(obj, selector));
}
