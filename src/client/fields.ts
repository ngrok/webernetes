type FieldSelector =
	| {
			field: string;
			value: string;
			operator: "==" | "!=";
	  }[]
	| undefined;

export function parseFieldSelector(selector: string | undefined): FieldSelector {
	if (!selector) {
		return undefined;
	}

	return selector
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const match = /^([^!=]+)\s*(!=|=|==)\s*(.*)$/.exec(part);
			if (!match) {
				throw new Error(`Invalid field selector: ${part}`);
			}
			return {
				field: match[1]?.trim() ?? "",
				operator: match[2] === "!=" ? "!=" : "==",
				value: match[3]?.trim() ?? "",
			};
		});
}

export function fieldSelectorMatches(obj: unknown, selector: FieldSelector): boolean {
	if (!selector) {
		return true;
	}

	return selector.every(({ field, operator, value }) => {
		const actual = String(getField(obj, field) ?? "");
		return operator === "!=" ? actual !== value : actual === value;
	});
}

export function filterByFields<T>(items: T[], selector: FieldSelector): T[] {
	if (!selector) {
		return items;
	}
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
