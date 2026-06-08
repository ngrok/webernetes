import { Set } from "../apimachinery/pkg/fields/fields";
import { parseSelector, type Selector } from "../apimachinery/pkg/fields/selector";

export type FieldSelector = Selector;

export function parseFieldSelector(selector: string | undefined): FieldSelector {
	const [fieldSelector, err] = parseSelector(selector ?? "");
	if (err) {
		throw err;
	}
	if (!fieldSelector) {
		throw new Error(`invalid selector: ${selector ?? ""}`);
	}
	return fieldSelector;
}

export function fieldSelectorMatches(obj: unknown, selector: FieldSelector): boolean {
	const fields: Record<string, string> = {};
	for (const requirement of selector.requirements() ?? []) {
		fields[requirement.field] = String(getField(obj, requirement.field) ?? "");
	}
	return selector.matches(new Set(fields));
}

export function filterByFields<T>(items: T[], selector: FieldSelector): T[] {
	return items.filter((item) => fieldSelectorMatches(item, selector));
}

function getField(obj: unknown, field: string): unknown {
	if (!obj || typeof obj !== "object") {
		return undefined;
	}

	return field.split(".").reduce<unknown>((current, part) => {
		if (!current || typeof current !== "object") {
			return undefined;
		}
		return (current as Record<string, unknown>)[part];
	}, obj);
}
