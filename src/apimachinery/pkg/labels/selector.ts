import { isLabelKey } from "../api/validate/content/kube";
import type { Operator } from "../selection/operator";
import {
	doesNotExist,
	doubleEquals,
	equals as equalsOperator,
	exists,
	greaterThan,
	inOperator,
	lessThan,
	notEquals,
	notIn,
} from "../selection/operator";
import { ErrorList, type FieldError, invalid, notSupported } from "../util/validation/field/errors";
import { childPath, Path, type PathOption, toPath, withPath } from "../util/validation/field/path";
import { newString, type StringSet } from "../util/sets/string";
import { isValidLabelValue } from "../util/validation/validation";
import { Set as LabelSet, type Labels } from "./labels";
import { parseInt } from "../../../go/strconv";

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go unaryOperators.
export const unaryOperators = [exists, doesNotExist];
// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go binaryOperators.
export const binaryOperators = [
	inOperator,
	notIn,
	equalsOperator,
	doubleEquals,
	notEquals,
	greaterThan,
	lessThan,
];
// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go validRequirementOperators.
export const validRequirementOperators = [...binaryOperators, ...unaryOperators];

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Requirements.
export type Requirements = Requirement[];

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Selector.
export interface Selector {
	matches(labels: Labels): boolean;
	empty(): boolean;
	string(): string;
	add(...requirements: Requirement[]): Selector;
	requirements(): [requirements: Requirements, selectable: boolean];
	deepCopySelector(): Selector;
	requiresExactMatch(label: string): [value: string, found: boolean];
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go internalSelector.
export class InternalSelector extends Array<Requirement> implements Selector {
	constructor(selector: Requirement[] = []) {
		super(...selector);
	}

	matches(labels: Labels): boolean {
		for (const requirement of this) {
			if (!requirement.matches(labels)) {
				return false;
			}
		}
		return true;
	}

	empty(): boolean {
		return this.length === 0;
	}

	string(): string {
		const reqs: string[] = [];
		for (const requirement of this) {
			reqs.push(requirement.string());
		}
		return reqs.join(",");
	}

	add(...requirements: Requirement[]): Selector {
		return new InternalSelector([...this, ...requirements].sort(byKey));
	}

	requirements(): [Requirements, boolean] {
		return [[...this], true];
	}

	deepCopySelector(): Selector {
		return new InternalSelector([...this]);
	}

	requiresExactMatch(label: string): [value: string, found: boolean] {
		for (const requirement of this) {
			if (requirement.key === label) {
				switch (requirement.operator) {
					case equalsOperator:
					case doubleEquals:
					case inOperator:
						if (requirement.valuesUnsorted().length === 1) {
							return [requirement.valuesUnsorted()[0] ?? "", true];
						}
				}
				return ["", false];
			}
		}
		return ["", false];
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go safeSort.
export function safeSort(in_: string[] | undefined): string[] | undefined {
	if (in_ === undefined) {
		return undefined;
	}
	if (in_.every((value, index) => index === 0 || (in_[index - 1] ?? "") <= value)) {
		return in_;
	}
	const out = [...in_];
	out.sort();
	return out;
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go ByKey.
function byKey(left: Requirement, right: Requirement): number {
	return left.key.localeCompare(right.key);
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go sharedEverythingSelector.
export const sharedEverythingSelector: Selector = new InternalSelector();

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Everything.
export function everything(): Selector {
	return sharedEverythingSelector;
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go nothingSelector.
export class NothingSelector implements Selector {
	matches(_labels: Labels): boolean {
		return false;
	}

	empty(): boolean {
		return false;
	}

	string(): string {
		return "";
	}

	add(..._requirements: Requirement[]): Selector {
		return this;
	}

	requirements(): [Requirements, boolean] {
		return [[], false];
	}

	deepCopySelector(): Selector {
		return this;
	}

	requiresExactMatch(_label: string): [value: string, found: boolean] {
		return ["", false];
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go sharedNothingSelector.
export const sharedNothingSelector: Selector = new NothingSelector();

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Nothing.
export function nothing(): Selector {
	return sharedNothingSelector;
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go MatchesNothing.
export function matchesNothing(selector: Selector): boolean {
	return selector === sharedNothingSelector;
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go NewSelector.
export function newSelector(): Selector {
	return new InternalSelector();
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Requirement.
export class Requirement {
	constructor(
		readonly key: string,
		readonly operator: Operator,
		readonly strValues: string[] = [],
	) {}

	matches(ls: Labels): boolean {
		switch (this.operator) {
			case inOperator:
			case equalsOperator:
			case doubleEquals: {
				const [val, found] = ls.lookup(this.key);
				return found && this.hasValue(val);
			}
			case notIn:
			case notEquals: {
				const [val, found] = ls.lookup(this.key);
				return !found || !this.hasValue(val);
			}
			case exists:
				return ls.has(this.key);
			case doesNotExist:
				return !ls.has(this.key);
			case greaterThan:
			case lessThan: {
				const [val, found] = ls.lookup(this.key);
				if (!found) {
					return false;
				}
				const [labelValue, labelErr] = parseInt(val, 10, 64);
				if (labelErr) {
					return false;
				}
				if (this.strValues.length !== 1) {
					return false;
				}
				let requirementValue = 0n;
				for (const strValue of this.strValues) {
					const [parsed, requirementErr] = parseInt(strValue, 10, 64);
					if (requirementErr) {
						return false;
					}
					requirementValue = parsed;
				}
				return this.operator === greaterThan
					? labelValue > requirementValue
					: labelValue < requirementValue;
			}
			default:
				return false;
		}
	}

	valuesUnsorted(): string[] {
		return [...this.strValues];
	}

	equal(other: Requirement): boolean {
		return (
			this.key === other.key &&
			this.operator === other.operator &&
			this.strValues.length === other.strValues.length &&
			this.strValues.every((value, index) => value === other.strValues[index])
		);
	}

	string(): string {
		switch (this.operator) {
			case doesNotExist:
				return `!${this.key}`;
			case exists:
				return this.key;
			case equalsOperator:
				return `${this.key}=${this.strValues[0] ?? ""}`;
			case doubleEquals:
				return `${this.key}==${this.strValues[0] ?? ""}`;
			case notEquals:
				return `${this.key}!=${this.strValues[0] ?? ""}`;
			case inOperator:
			case notIn:
				return `${this.key} ${this.operator} (${[...this.strValues].sort().join(",")})`;
			case greaterThan:
				return `${this.key}>${this.strValues[0] ?? ""}`;
			case lessThan:
				return `${this.key}<${this.strValues[0] ?? ""}`;
			default:
				return "";
		}
	}

	private hasValue(value: string): boolean {
		return this.strValues.includes(value);
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go NewRequirement.
export function newRequirement(
	key: string,
	op: Operator,
	vals: string[] = [],
	...opts: PathOption[]
): [requirement: Requirement | undefined, err: Error | undefined] {
	const allErrs = new ErrorList();
	const path = toPath(...opts);
	const keyErr = validateLabelKey(key, childPath(path, "key"));
	if (keyErr) {
		allErrs.push(keyErr);
	}
	const valuePath = childPath(path, "values");
	switch (op) {
		case inOperator:
		case notIn:
			if (vals.length === 0) {
				allErrs.push(
					invalid(valuePath, vals, "for 'in', 'notin' operators, values set can't be empty"),
				);
			}
			break;
		case equalsOperator:
		case doubleEquals:
		case notEquals:
			if (vals.length !== 1) {
				allErrs.push(
					invalid(valuePath, vals, "exact-match compatibility requires one single value"),
				);
			}
			break;
		case exists:
		case doesNotExist:
			if (vals.length !== 0) {
				allErrs.push(
					invalid(valuePath, vals, "values set must be empty for exists and does not exist"),
				);
			}
			break;
		case greaterThan:
		case lessThan:
			if (vals.length !== 1) {
				allErrs.push(
					invalid(valuePath, vals, "for 'Gt', 'Lt' operators, exactly one value is required"),
				);
			}
			for (let i = 0; i < vals.length; i++) {
				const [, err] = parseInt(vals[i] ?? "", 10, 64);
				if (err) {
					allErrs.push(
						invalid(
							valuePath?.index(i),
							vals[i],
							"for 'Gt', 'Lt' operators, the value must be an integer",
						),
					);
				}
			}
			break;
		default:
			allErrs.push(notSupported(childPath(path, "operator"), op, validRequirementOperators));
	}
	for (let i = 0; i < vals.length; i++) {
		const err = validateLabelValue(key, vals[i] ?? "", valuePath?.index(i));
		if (err) {
			allErrs.push(err);
		}
	}
	return [new Requirement(key, op, vals), allErrs.toAggregate()];
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go SelectorFromSet.
export function selectorFromSet(ls: LabelSet): Selector {
	return selectorFromValidatedSet(ls);
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go ValidatedSelectorFromSet.
export function validatedSelectorFromSet(
	ls: LabelSet,
): [selector: Selector | undefined, err: Error | undefined] {
	if (ls.size === 0) {
		return [new InternalSelector(), undefined];
	}
	const requirements: Requirement[] = [];
	for (const [key, value] of ls.entries()) {
		const [requirement, err] = newRequirement(key, equalsOperator, [value]);
		if (err || !requirement) {
			return [undefined, err];
		}
		requirements.push(requirement);
	}
	requirements.sort(byKey);
	return [new InternalSelector(requirements), undefined];
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go SelectorFromValidatedSet.
export function selectorFromValidatedSet(ls: LabelSet): Selector {
	if (ls.size === 0) {
		return new InternalSelector();
	}
	const requirements: Requirement[] = [];
	for (const [key, value] of ls.entries()) {
		requirements.push(new Requirement(key, equalsOperator, [value]));
	}
	requirements.sort(byKey);
	return new InternalSelector(requirements);
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Parse.
export function parse(
	selector: string,
	...opts: PathOption[]
): [selector: Selector | undefined, err: Error | undefined] {
	const [parsedSelector, err] = parseInternal(selector, toPath(...opts));
	if (!err) {
		return [parsedSelector, undefined];
	}
	return [undefined, err];
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go parse.
function parseInternal(
	selector: string,
	path: Path | undefined,
): [selector: InternalSelector | undefined, err: Error | undefined] {
	const p = new Parser(new Lexer(selector), path);
	const [items, err] = p.parse();
	if (err) {
		return [undefined, err];
	}
	items.sort(byKey);
	return [new InternalSelector(items), undefined];
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go validateLabelKey.
export function validateLabelKey(k: string, path: Path | undefined): FieldError | undefined {
	const errs = isLabelKey(k);
	if (errs.length !== 0) {
		return invalid(path, k, errs.join("; "));
	}
	return undefined;
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go validateLabelValue.
export function validateLabelValue(
	k: string,
	v: string,
	path: Path | undefined,
): FieldError | undefined {
	const errs = isValidLabelValue(v);
	if (errs.length !== 0) {
		return invalid(path ? path.key(k) : new Path("", k, undefined), v, errs.join("; "));
	}
	return undefined;
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go ParseToRequirements.
export function parseToRequirements(
	selector: string,
	...opts: PathOption[]
): [requirements: Requirements | undefined, err: Error | undefined] {
	return parseInternal(selector, toPath(...opts));
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go ValidatedSetSelector.
export class ValidatedSetSelector implements Selector {
	constructor(private readonly labels: LabelSet) {}

	matches(labels: Labels): boolean {
		for (const [k, v] of this.labels.entries()) {
			const [val, exists] = labels.lookup(k);
			if (!exists || v !== val) {
				return false;
			}
		}
		return true;
	}

	empty(): boolean {
		return this.labels.size === 0;
	}

	string(): string {
		return this.labels.string();
	}

	add(...requirements: Requirement[]): Selector {
		return this.toFullSelector().add(...requirements);
	}

	requirements(): [Requirements, boolean] {
		return this.toFullSelector().requirements();
	}

	deepCopySelector(): Selector {
		return new ValidatedSetSelector(new LabelSet(this.labels));
	}

	requiresExactMatch(label: string): [value: string, found: boolean] {
		const v = this.labels.get(label);
		if (v === undefined) {
			return ["", false];
		}
		return [v, true];
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go ValidatedSetSelector.toFullSelector.
	toFullSelector(): Selector {
		return selectorFromValidatedSet(this.labels);
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Token.
export type Token =
	| "ErrorToken"
	| "EndOfStringToken"
	| "ClosedParToken"
	| "CommaToken"
	| "DoesNotExistToken"
	| "DoubleEqualsToken"
	| "EqualsToken"
	| "GreaterThanToken"
	| "IdentifierToken"
	| "InToken"
	| "LessThanToken"
	| "NotEqualsToken"
	| "NotInToken"
	| "OpenParToken";

export const errorToken: Token = "ErrorToken";
export const endOfStringToken: Token = "EndOfStringToken";
export const closedParToken: Token = "ClosedParToken";
export const commaToken: Token = "CommaToken";
export const doesNotExistToken: Token = "DoesNotExistToken";
export const doubleEqualsToken: Token = "DoubleEqualsToken";
export const equalsToken: Token = "EqualsToken";
export const greaterThanToken: Token = "GreaterThanToken";
export const identifierToken: Token = "IdentifierToken";
export const inToken: Token = "InToken";
export const lessThanToken: Token = "LessThanToken";
export const notEqualsToken: Token = "NotEqualsToken";
export const notInToken: Token = "NotInToken";
export const openParToken: Token = "OpenParToken";

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go string2token.
const string2token = new Map<string, Token>([
	[")", closedParToken],
	[",", commaToken],
	["!", doesNotExistToken],
	["==", doubleEqualsToken],
	["=", equalsToken],
	[">", greaterThanToken],
	["in", inToken],
	["<", lessThanToken],
	["!=", notEqualsToken],
	["notin", notInToken],
	["(", openParToken],
]);

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go ScannedItem.
export class ScannedItem {
	constructor(
		readonly tok: Token,
		readonly literal: string,
	) {}
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go isWhitespace.
function isWhitespace(ch: string): boolean {
	return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go isSpecialSymbol.
function isSpecialSymbol(ch: string): boolean {
	switch (ch) {
		case "=":
		case "!":
		case "(":
		case ")":
		case ",":
		case ">":
		case "<":
			return true;
	}
	return false;
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Lexer.
export class Lexer {
	private pos = 0;

	constructor(private readonly s: string) {}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Lexer.read.
	read(): string {
		let b = "";
		if (this.pos < this.s.length) {
			b = this.s[this.pos] ?? "";
			this.pos++;
		}
		return b;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Lexer.unread.
	unread(): void {
		this.pos--;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Lexer.scanIDOrKeyword.
	scanIDOrKeyword(): [tok: Token, lit: string] {
		let buffer = "";
		while (true) {
			const ch = this.read();
			if (ch === "") {
				break;
			}
			if (isSpecialSymbol(ch) || isWhitespace(ch)) {
				this.unread();
				break;
			}
			buffer += ch;
		}
		const tok = string2token.get(buffer);
		if (tok) {
			return [tok, buffer];
		}
		return [identifierToken, buffer];
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Lexer.scanSpecialSymbol.
	scanSpecialSymbol(): [tok: Token, lit: string] {
		let lastScannedItem = new ScannedItem(errorToken, "");
		let buffer = "";
		while (true) {
			const ch = this.read();
			if (ch === "") {
				break;
			}
			if (isSpecialSymbol(ch)) {
				buffer += ch;
				const token = string2token.get(buffer);
				if (token) {
					lastScannedItem = new ScannedItem(token, buffer);
				} else if (lastScannedItem.tok !== errorToken) {
					this.unread();
					break;
				}
			} else {
				this.unread();
				break;
			}
		}
		if (lastScannedItem.tok === errorToken) {
			return [errorToken, `error expected: keyword found '${buffer}'`];
		}
		return [lastScannedItem.tok, lastScannedItem.literal];
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Lexer.skipWhiteSpaces.
	skipWhiteSpaces(ch: string): string {
		while (true) {
			if (!isWhitespace(ch)) {
				return ch;
			}
			ch = this.read();
		}
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Lexer.Lex.
	lex(): [tok: Token, lit: string] {
		const ch = this.skipWhiteSpaces(this.read());
		if (ch === "") {
			return [endOfStringToken, ""];
		}
		if (isSpecialSymbol(ch)) {
			this.unread();
			return this.scanSpecialSymbol();
		}
		this.unread();
		return this.scanIDOrKeyword();
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go ParserContext.
export type ParserContext = "KeyAndOperator" | "Values";
export const keyAndOperator: ParserContext = "KeyAndOperator";
export const values: ParserContext = "Values";

// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Parser.
export class Parser {
	scannedItems: ScannedItem[] = [];
	position = 0;

	constructor(
		private readonly l: Lexer,
		private readonly path: Path | undefined = undefined,
	) {}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Parser.lookahead.
	lookahead(context: ParserContext): [tok: Token, lit: string] {
		let tok = this.scannedItems[this.position]?.tok ?? endOfStringToken;
		const lit = this.scannedItems[this.position]?.literal ?? "";
		if (context === values) {
			switch (tok) {
				case inToken:
				case notInToken:
					tok = identifierToken;
			}
		}
		return [tok, lit];
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Parser.consume.
	consume(context: ParserContext): [tok: Token, lit: string] {
		this.position++;
		let tok = this.scannedItems[this.position - 1]?.tok ?? endOfStringToken;
		const lit = this.scannedItems[this.position - 1]?.literal ?? "";
		if (context === values) {
			switch (tok) {
				case inToken:
				case notInToken:
					tok = identifierToken;
			}
		}
		return [tok, lit];
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Parser.scan.
	scan(): void {
		while (true) {
			const [token, literal] = this.l.lex();
			this.scannedItems.push(new ScannedItem(token, literal));
			if (token === endOfStringToken) {
				break;
			}
		}
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Parser.parse.
	parse(): [requirements: Requirement[], err: Error | undefined] {
		this.scan();
		const requirements: Requirement[] = [];
		while (true) {
			const [tok, lit] = this.lookahead(values);
			switch (tok) {
				case identifierToken:
				case doesNotExistToken: {
					const [r, err] = this.parseRequirement();
					if (err || !r) {
						return [[], new Error(`unable to parse requirement: ${err?.message}`)];
					}
					requirements.push(r);
					const [t, l] = this.consume(values);
					switch (t) {
						case endOfStringToken:
							return [requirements, undefined];
						case commaToken: {
							const [t2, l2] = this.lookahead(values);
							if (t2 !== identifierToken && t2 !== doesNotExistToken) {
								return [[], new Error(`found '${l2}', expected: identifier after ','`)];
							}
							break;
						}
						default:
							return [[], new Error(`found '${l}', expected: ',' or 'end of string'`)];
					}
					break;
				}
				case endOfStringToken:
					return [requirements, undefined];
				default:
					return [[], new Error(`found '${lit}', expected: !, identifier, or 'end of string'`)];
			}
		}
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Parser.parseRequirement.
	parseRequirement(): [requirement: Requirement | undefined, err: Error | undefined] {
		const [key, operator, err] = this.parseKeyAndInferOperator();
		if (err) {
			return [undefined, err];
		}
		if (operator === exists || operator === doesNotExist) {
			return newRequirement(key, operator, [], withPath(this.path));
		}
		const [op, operatorErr] = this.parseOperator();
		if (operatorErr || !op) {
			return [undefined, operatorErr];
		}
		let valueSet: StringSet | undefined;
		let valueErr: Error | undefined;
		switch (op) {
			case inOperator:
			case notIn:
				[valueSet, valueErr] = this.parseValues();
				break;
			case equalsOperator:
			case doubleEquals:
			case notEquals:
			case greaterThan:
			case lessThan:
				[valueSet, valueErr] = this.parseExactValue();
				break;
		}
		if (valueErr || !valueSet) {
			return [undefined, valueErr];
		}
		return newRequirement(key, op, valueSet.list(), withPath(this.path));
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Parser.parseKeyAndInferOperator.
	parseKeyAndInferOperator(): [key: string, op: Operator | undefined, err: Error | undefined] {
		let operator: Operator | undefined;
		let [tok, literal] = this.consume(values);
		if (tok === doesNotExistToken) {
			operator = doesNotExist;
			[tok, literal] = this.consume(values);
		}
		if (tok !== identifierToken) {
			return ["", undefined, new Error(`found '${literal}', expected: identifier`)];
		}
		const err = validateLabelKey(literal, this.path);
		if (err) {
			return ["", undefined, err];
		}
		const [t] = this.lookahead(values);
		if (t === endOfStringToken || t === commaToken) {
			if (operator !== doesNotExist) {
				operator = exists;
			}
		}
		return [literal, operator, undefined];
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Parser.parseOperator.
	parseOperator(): [op: Operator | undefined, err: Error | undefined] {
		const [tok, lit] = this.consume(keyAndOperator);
		switch (tok) {
			case inToken:
				return [inOperator, undefined];
			case equalsToken:
				return [equalsOperator, undefined];
			case doubleEqualsToken:
				return [doubleEquals, undefined];
			case greaterThanToken:
				return [greaterThan, undefined];
			case lessThanToken:
				return [lessThan, undefined];
			case notInToken:
				return [notIn, undefined];
			case notEqualsToken:
				return [notEquals, undefined];
			default:
				return [undefined, new Error(`found '${lit}', expected: ${binaryOperators.join(", ")}`)];
		}
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Parser.parseValues.
	parseValues(): [values: StringSet | undefined, err: Error | undefined] {
		let [tok, lit] = this.consume(values);
		if (tok !== openParToken) {
			return [undefined, new Error(`found '${lit}' expected: '('`)];
		}
		[tok, lit] = this.lookahead(values);
		switch (tok) {
			case identifierToken:
			case commaToken: {
				const [s, err] = this.parseIdentifiersList();
				if (err) {
					return [s, err];
				}
				[tok] = this.consume(values);
				if (tok !== closedParToken) {
					return [undefined, new Error(`found '${lit}', expected: ')'`)];
				}
				return [s, undefined];
			}
			case closedParToken:
				this.consume(values);
				return [newString(""), undefined];
			default:
				return [undefined, new Error(`found '${lit}', expected: ',', ')' or identifier`)];
		}
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Parser.parseIdentifiersList.
	parseIdentifiersList(): [values: StringSet, err: Error | undefined] {
		const s = newString();
		while (true) {
			const [tok, lit] = this.consume(values);
			switch (tok) {
				case identifierToken: {
					s.insert(lit);
					const [tok2, lit2] = this.lookahead(values);
					switch (tok2) {
						case commaToken:
							continue;
						case closedParToken:
							return [s, undefined];
						default:
							return [s, new Error(`found '${lit2}', expected: ',' or ')'`)];
					}
				}
				case commaToken: {
					if (s.len() === 0) {
						s.insert("");
					}
					const [tok2] = this.lookahead(values);
					if (tok2 === closedParToken) {
						s.insert("");
						return [s, undefined];
					}
					if (tok2 === commaToken) {
						s.insert("");
					}
					break;
				}
				default:
					return [s, new Error(`found '${lit}', expected: ',', or identifier`)];
			}
		}
	}

	// Models staging/src/k8s.io/apimachinery/pkg/labels/selector.go Parser.parseExactValue.
	parseExactValue(): [values: StringSet | undefined, err: Error | undefined] {
		const s = newString();
		let [tok] = this.lookahead(values);
		if (tok === endOfStringToken || tok === commaToken) {
			s.insert("");
			return [s, undefined];
		}
		let lit: string;
		[tok, lit] = this.consume(values);
		if (tok === identifierToken) {
			s.insert(lit);
			return [s, undefined];
		}
		return [undefined, new Error(`found '${lit}', expected: identifier`)];
	}
}
