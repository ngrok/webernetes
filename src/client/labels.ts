import { KubernetesObject } from "./types";

export function parseLabelSelector(selector?: string): Record<string, string> {
	if (!selector) {
		return {};
	}

	const result: Record<string, string> = {};
	for (const pair of selector.split(",")) {
		const [key, value] = pair.split("=");
		if (key && value) {
			result[key.trim()] = value.trim();
		}
	}

	return result;
}

export function labelsMatch(obj: KubernetesObject, selector: Record<string, string>): boolean {
	if (Object.keys(selector).length === 0) {
		return true;
	}

	if (!obj.metadata?.labels) {
		return false;
	}

	for (const [key, value] of Object.entries(selector)) {
		if (obj.metadata.labels[key] !== value) {
			return false;
		}
	}

	return true;
}

export function filterByLabels<T extends KubernetesObject>(
	objects: T[],
	selector: Record<string, string>,
): T[] {
	return objects.filter((obj) => labelsMatch(obj, selector));
}
