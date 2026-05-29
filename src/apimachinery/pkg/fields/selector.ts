import { equals, notEquals } from "../selection/operator";
import type { Fields, Set } from "./fields";
import type { Requirements } from "./requirements";

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go Selector.
export interface Selector {
	matches(fields: Fields): boolean;
	empty(): boolean;
	requiresExactMatch(field: string): [value: string, found: boolean];
	transform(fn: TransformFunc): [selector: Selector | undefined, err: Error | undefined];
	requirements(): Requirements;
	string(): string;
	deepCopySelector(): Selector | undefined;
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go nothingSelector.
export class NothingSelector implements Selector {
	matches(_fields: Fields): boolean {
		return false;
	}

	empty(): boolean {
		return false;
	}

	string(): string {
		return "";
	}

	requirements(): Requirements {
		return undefined;
	}

	deepCopySelector(): Selector {
		return this;
	}

	requiresExactMatch(_field: string): [value: string, found: boolean] {
		return ["", false];
	}

	transform(_fn: TransformFunc): [selector: Selector | undefined, err: Error | undefined] {
		return [this, undefined];
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go Nothing.
export function nothing(): Selector {
	return new NothingSelector();
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go Everything.
export function everything(): Selector {
	return new AndTerm();
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go hasTerm.
export class HasTerm implements Selector {
	constructor(
		readonly field: string,
		readonly value: string,
	) {}

	matches(fields: Fields): boolean {
		return fields.get(this.field) === this.value;
	}

	empty(): boolean {
		return false;
	}

	requiresExactMatch(field: string): [value: string, found: boolean] {
		if (this.field === field) {
			return [this.value, true];
		}
		return ["", false];
	}

	transform(fn: TransformFunc): [selector: Selector | undefined, err: Error | undefined] {
		const [field, value, err] = fn(this.field, this.value);
		if (err) {
			return [undefined, err];
		}
		if (field.length === 0 && value.length === 0) {
			return [everything(), undefined];
		}
		return [new HasTerm(field, value), undefined];
	}

	requirements(): Requirements {
		return [
			{
				field: this.field,
				operator: equals,
				value: this.value,
			},
		];
	}

	string(): string {
		return `${this.field}=${escapeValue(this.value)}`;
	}

	deepCopySelector(): Selector {
		return new HasTerm(this.field, this.value);
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go notHasTerm.
export class NotHasTerm implements Selector {
	constructor(
		readonly field: string,
		readonly value: string,
	) {}

	matches(fields: Fields): boolean {
		return fields.get(this.field) !== this.value;
	}

	empty(): boolean {
		return false;
	}

	requiresExactMatch(_field: string): [value: string, found: boolean] {
		return ["", false];
	}

	transform(fn: TransformFunc): [selector: Selector | undefined, err: Error | undefined] {
		const [field, value, err] = fn(this.field, this.value);
		if (err) {
			return [undefined, err];
		}
		if (field.length === 0 && value.length === 0) {
			return [everything(), undefined];
		}
		return [new NotHasTerm(field, value), undefined];
	}

	requirements(): Requirements {
		return [
			{
				field: this.field,
				operator: notEquals,
				value: this.value,
			},
		];
	}

	string(): string {
		return `${this.field}!=${escapeValue(this.value)}`;
	}

	deepCopySelector(): Selector {
		return new NotHasTerm(this.field, this.value);
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go andTerm.
export class AndTerm implements Selector {
	constructor(readonly selectors: Selector[] = []) {}

	matches(fields: Fields): boolean {
		for (const selector of this.selectors) {
			if (!selector.matches(fields)) {
				return false;
			}
		}
		return true;
	}

	empty(): boolean {
		if (this.selectors.length === 0) {
			return true;
		}
		for (const selector of this.selectors) {
			if (!selector.empty()) {
				return false;
			}
		}
		return true;
	}

	requiresExactMatch(field: string): [value: string, found: boolean] {
		if (this.selectors.length === 0) {
			return ["", false];
		}
		for (const selector of this.selectors) {
			const [value, found] = selector.requiresExactMatch(field);
			if (found) {
				return [value, found];
			}
		}
		return ["", false];
	}

	transform(fn: TransformFunc): [selector: Selector | undefined, err: Error | undefined] {
		const next: Selector[] = [];
		for (const selector of this.selectors) {
			const [n, err] = selector.transform(fn);
			if (err) {
				return [undefined, err];
			}
			if (n && !n.empty()) {
				next.push(n);
			}
		}
		return [new AndTerm(next), undefined];
	}

	requirements(): Requirements {
		const reqs: NonNullable<Requirements> = [];
		for (const selector of this.selectors) {
			const rs = selector.requirements();
			if (rs) {
				reqs.push(...rs);
			}
		}
		return reqs;
	}

	string(): string {
		const terms: string[] = [];
		for (const selector of this.selectors) {
			terms.push(selector.string());
		}
		return terms.join(",");
	}

	deepCopySelector(): Selector {
		const out: Selector[] = [];
		for (const selector of this.selectors) {
			const copied = selector.deepCopySelector();
			if (copied) {
				out.push(copied);
			}
		}
		return new AndTerm(out);
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go SelectorFromSet.
export function selectorFromSet(set: Set | undefined): Selector {
	if (set === undefined || set.fields === undefined) {
		return everything();
	}
	const items: Selector[] = [];
	for (const [field, value] of Object.entries(set.fields)) {
		items.push(new HasTerm(field, value));
	}
	if (items.length === 1) {
		return items[0] as Selector;
	}
	return new AndTerm(items);
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go EscapeValue.
export function escapeValue(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll(",", "\\,").replaceAll("=", "\\=");
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go InvalidEscapeSequence.
export class InvalidEscapeSequence extends Error {
	constructor(readonly sequence: string) {
		super(`invalid field selector: invalid escape sequence: ${sequence}`);
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go UnescapedRune.
export class UnescapedRune extends Error {
	constructor(readonly rune: string) {
		super(`invalid field selector: unescaped character in value: ${rune}`);
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go UnescapeValue.
export function unescapeValue(s: string): [value: string, err: Error | undefined] {
	if (!/[\\,=]/.test(s)) {
		return [s, undefined];
	}

	let v = "";
	let inSlash = false;
	for (const c of s) {
		if (inSlash) {
			switch (c) {
				case "\\":
				case ",":
				case "=":
					v += c;
					break;
				default:
					return ["", new InvalidEscapeSequence(`\\${c}`)];
			}
			inSlash = false;
			continue;
		}

		switch (c) {
			case "\\":
				inSlash = true;
				break;
			case ",":
			case "=":
				return ["", new UnescapedRune(c)];
			default:
				v += c;
				break;
		}
	}

	if (inSlash) {
		return ["", new InvalidEscapeSequence("\\")];
	}

	return [v, undefined];
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go ParseSelectorOrDie.
export function parseSelectorOrDie(s: string): Selector {
	const [selector, err] = parseSelector(s);
	if (err) {
		throw err;
	}
	return selector as Selector;
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go ParseSelector.
export function parseSelector(
	selector: string,
): [selector: Selector | undefined, err: Error | undefined] {
	return parseSelectorInternal(selector, (lhs, rhs) => [lhs, rhs, undefined]);
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go ParseAndTransformSelector.
export function parseAndTransformSelector(
	selector: string,
	fn: TransformFunc,
): [selector: Selector | undefined, err: Error | undefined] {
	return parseSelectorInternal(selector, fn);
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go TransformFunc.
export type TransformFunc = (
	field: string,
	value: string,
) => readonly [newField: string, newValue: string, err: Error | undefined];

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go splitTerms.
export function splitTerms(fieldSelector: string): string[] | undefined {
	if (fieldSelector.length === 0) {
		return undefined;
	}

	const terms: string[] = [];
	let startIndex = 0;
	let inSlash = false;
	for (let i = 0; i < fieldSelector.length; i++) {
		const c = fieldSelector[i];
		if (inSlash) {
			inSlash = false;
		} else if (c === "\\") {
			inSlash = true;
		} else if (c === ",") {
			terms.push(fieldSelector.slice(startIndex, i));
			startIndex = i + 1;
		}
	}

	terms.push(fieldSelector.slice(startIndex));

	return terms;
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go notEqualOperator.
const notEqualOperator = "!=";

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go doubleEqualOperator.
const doubleEqualOperator = "==";

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go equalOperator.
const equalOperator = "=";

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go termOperators.
const termOperators = [notEqualOperator, doubleEqualOperator, equalOperator];

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go splitTerm.
export function splitTerm(term: string): [lhs: string, op: string, rhs: string, ok: boolean] {
	for (let i = 0; i < term.length; i++) {
		const remaining = term.slice(i);
		for (const op of termOperators) {
			if (remaining.startsWith(op)) {
				return [term.slice(0, i), op, term.slice(i + op.length), true];
			}
		}
	}
	return ["", "", "", false];
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go parseSelector.
function parseSelectorInternal(
	selector: string,
	fn: TransformFunc,
): [selector: Selector | undefined, err: Error | undefined] {
	const parts = splitTerms(selector) ?? [];
	parts.sort();
	const items: Selector[] = [];
	for (const part of parts) {
		if (part === "") {
			continue;
		}
		const [lhs, op, rhs, ok] = splitTerm(part);
		if (!ok) {
			return [undefined, new Error(`invalid selector: '${selector}'; can't understand '${part}'`)];
		}
		const [unescapedRHS, err] = unescapeValue(rhs);
		if (err) {
			return [undefined, err];
		}
		switch (op) {
			case notEqualOperator:
				items.push(new NotHasTerm(lhs, unescapedRHS));
				break;
			case doubleEqualOperator:
				items.push(new HasTerm(lhs, unescapedRHS));
				break;
			case equalOperator:
				items.push(new HasTerm(lhs, unescapedRHS));
				break;
			default:
				return [
					undefined,
					new Error(`invalid selector: '${selector}'; can't understand '${part}'`),
				];
		}
	}
	if (items.length === 1) {
		return items[0]?.transform(fn) ?? [undefined, undefined];
	}
	return new AndTerm(items).transform(fn);
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go OneTermEqualSelector.
export function oneTermEqualSelector(key: string, value: string): Selector {
	return new HasTerm(key, value);
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go OneTermNotEqualSelector.
export function oneTermNotEqualSelector(key: string, value: string): Selector {
	return new NotHasTerm(key, value);
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go AndSelectors.
export function andSelectors(...selectors: Selector[]): Selector {
	return new AndTerm(selectors);
}
