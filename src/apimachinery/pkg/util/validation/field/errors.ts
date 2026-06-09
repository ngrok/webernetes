/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { type Aggregate, filterOut, type Matcher, newAggregate } from "../../errors/errors";
import { newString } from "../../sets/string";
import type { Path } from "./path";

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go Error.
export class FieldError extends Error {
	origin = "";
	coveredByDeclarative = false;
	fromImperative = false;
	validationStabilityLevel: ValidationStabilityLevel = stabilityLevelUnknown;

	constructor(
		readonly type: ErrorType,
		readonly field: string,
		readonly badValue: unknown,
		public detail = "",
	) {
		super(`${field}: ${fieldErrorBody(type, badValue, detail)}`);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go IsAlpha.
	isAlpha(): boolean {
		return this.validationStabilityLevel === stabilityLevelAlpha;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go IsBeta.
	isBeta(): boolean {
		return this.validationStabilityLevel === stabilityLevelBeta;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go Error.
	error(): string {
		return `${this.field}: ${this.errorBody()}`;
	}

	toString(): string {
		return this.error();
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorBody.
	errorBody(): string {
		return fieldErrorBody(this.type, this.badValue, this.detail);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go WithOrigin.
	withOrigin(o: string): FieldError {
		this.origin = o;
		return this;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go MarkCoveredByDeclarative.
	markCoveredByDeclarative(): FieldError {
		this.coveredByDeclarative = true;
		return this;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go MarkAlpha.
	markAlpha(): FieldError {
		this.validationStabilityLevel = stabilityLevelAlpha;
		return this;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go MarkBeta.
	markBeta(): FieldError {
		this.validationStabilityLevel = stabilityLevelBeta;
		return this;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go MarkFromImperative.
	markFromImperative(): FieldError {
		this.fromImperative = true;
		return this;
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ValidationStabilityLevel.
export type ValidationStabilityLevel = 0 | 1 | 2;

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go stabilityLevelUnknown.
export const stabilityLevelUnknown = 0;
// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go stabilityLevelAlpha.
export const stabilityLevelAlpha = 1;
// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go stabilityLevelBeta.
export const stabilityLevelBeta = 2;

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ValidationStabilityLevel.String.
export function validationStabilityLevelString(v: ValidationStabilityLevel): string {
	switch (v) {
		case stabilityLevelAlpha:
			return "alpha";
		case stabilityLevelBeta:
			return "beta";
		default:
			return "unknown";
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go OmitValueType.
// oxlint-disable-next-line typescript-eslint/no-extraneous-class -- Mirrors upstream sentinel type.
export class OmitValueType {}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go omitValue.
export const omitValue = new OmitValueType();

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorType.
export type ErrorType =
	| "FieldValueNotFound"
	| "FieldValueRequired"
	| "FieldValueDuplicate"
	| "FieldValueInvalid"
	| "FieldValueNotSupported"
	| "FieldValueForbidden"
	| "FieldValueTooLong"
	| "FieldValueTooMany"
	| "FieldValueTooFew"
	| "InternalError"
	| "FieldValueTypeInvalid"
	| "FieldValueTooShort";

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorTypeNotFound.
export const errorTypeNotFound = "FieldValueNotFound";
// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorTypeRequired.
export const errorTypeRequired = "FieldValueRequired";
// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorTypeDuplicate.
export const errorTypeDuplicate = "FieldValueDuplicate";
// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorTypeInvalid.
export const errorTypeInvalid = "FieldValueInvalid";
// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorTypeNotSupported.
export const errorTypeNotSupported = "FieldValueNotSupported";
// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorTypeForbidden.
export const errorTypeForbidden = "FieldValueForbidden";
// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorTypeTooLong.
export const errorTypeTooLong = "FieldValueTooLong";
// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorTypeTooMany.
export const errorTypeTooMany = "FieldValueTooMany";
// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorTypeTooFew.
export const errorTypeTooFew = "FieldValueTooFew";
// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorTypeInternal.
export const errorTypeInternal = "InternalError";
// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorTypeTypeInvalid.
export const errorTypeTypeInvalid = "FieldValueTypeInvalid";
// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorTypeTooShort.
export const errorTypeTooShort = "FieldValueTooShort";

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorType.String.
export function errorTypeString(t: ErrorType): string {
	switch (t) {
		case errorTypeNotFound:
			return "Not found";
		case errorTypeRequired:
			return "Required value";
		case errorTypeDuplicate:
			return "Duplicate value";
		case errorTypeInvalid:
			return "Invalid value";
		case errorTypeNotSupported:
			return "Unsupported value";
		case errorTypeForbidden:
			return "Forbidden";
		case errorTypeTooLong:
			return "Too long";
		case errorTypeTooMany:
			return "Too many";
		case errorTypeTooFew:
			return "Too few";
		case errorTypeInternal:
			return "Internal error";
		case errorTypeTypeInvalid:
			return "Invalid value";
		case errorTypeTooShort:
			return "Too short";
		default:
			return `<unknown error ${JSON.stringify(t)}>`;
	}
}

function fieldErrorBody(type: ErrorType, badValue: unknown, detail: string): string {
	let s = "";
	switch (type) {
		case errorTypeRequired:
		case errorTypeForbidden:
		case errorTypeTooLong:
		case errorTypeTooShort:
		case errorTypeInternal:
			s = errorTypeString(type);
			break;
		case errorTypeInvalid:
		case errorTypeTypeInvalid:
		case errorTypeNotSupported:
		case errorTypeNotFound:
		case errorTypeDuplicate:
		case errorTypeTooMany:
		case errorTypeTooFew:
			if (badValue === omitValue) {
				s = errorTypeString(type);
				break;
			}
			if (typeof badValue === "number" || typeof badValue === "boolean") {
				s = `${errorTypeString(type)}: ${String(badValue)}`;
			} else if (typeof badValue === "string") {
				s = `${errorTypeString(type)}: ${JSON.stringify(badValue)}`;
			} else {
				s = `${errorTypeString(type)}: ${JSON.stringify(badValue)}`;
			}
			break;
		default:
			s = internalError(
				undefined,
				new Error(`unhandled error code: ${type}: please report this`),
			).errorBody();
	}
	if (detail.length !== 0) {
		s += `: ${detail}`;
	}
	return s;
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go TypeInvalid.
export function typeInvalid(path: Path | undefined, value: unknown, detail: string): FieldError {
	return new FieldError(errorTypeTypeInvalid, fieldString(path), value, detail);
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go NotFound.
export function notFound(path: Path | undefined, value: unknown): FieldError {
	return new FieldError(errorTypeNotFound, fieldString(path), value);
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go Required.
export function required(path: Path | undefined, detail: string): FieldError {
	return new FieldError(errorTypeRequired, fieldString(path), "", detail);
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go Duplicate.
export function duplicate(path: Path | undefined, value: unknown): FieldError {
	return new FieldError(errorTypeDuplicate, fieldString(path), value);
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go Invalid.
export function invalid(path: Path | undefined, value: unknown, detail: string): FieldError {
	return new FieldError(errorTypeInvalid, fieldString(path), value, detail);
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go NotSupported.
export function notSupported(
	path: Path | undefined,
	value: unknown,
	validValues: unknown[],
): FieldError {
	let detail = "";
	if (validValues.length > 0) {
		const quotedValues = new Array<string>(validValues.length);
		for (let i = 0; i < validValues.length; i++) {
			quotedValues[i] = JSON.stringify(String(validValues[i]));
		}
		detail = `supported values: ${quotedValues.join(", ")}`;
	}
	return new FieldError(errorTypeNotSupported, fieldString(path), value, detail);
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go Forbidden.
export function forbidden(path: Path | undefined, detail: string): FieldError {
	return new FieldError(errorTypeForbidden, fieldString(path), "", detail);
}
// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go TooLong.
export function tooLong(path: Path | undefined, _value: unknown, maxLength: number): FieldError {
	let msg = "";
	if (maxLength >= 0) {
		let bs = "bytes";
		if (maxLength === 1) {
			bs = "byte";
		}
		msg = `may not be more than ${maxLength} ${bs}`;
	} else {
		msg = "value is too long";
	}
	return new FieldError(errorTypeTooLong, fieldString(path), "<value omitted>", msg);
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go TooLongCharacters.
export function tooLongCharacters(
	path: Path | undefined,
	_value: string,
	maxLength: number,
): FieldError {
	let msg = "";
	if (maxLength >= 0) {
		let bs = "characters";
		if (maxLength === 1) {
			bs = "character";
		}
		msg = `may not be more than ${maxLength} ${bs}`;
	} else {
		msg = "value is too long";
	}
	return new FieldError(errorTypeTooLong, fieldString(path), "<value omitted>", msg);
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go TooLongMaxLength.
export function tooLongMaxLength(
	path: Path | undefined,
	_value: unknown,
	maxLength: number,
): FieldError {
	return tooLong(path, "", maxLength);
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go TooMany.
export function tooMany(
	path: Path | undefined,
	actualQuantity: number,
	maxQuantity: number,
): FieldError {
	let msg = "";

	if (maxQuantity >= 0) {
		let is = "items";
		if (maxQuantity === 1) {
			is = "item";
		}
		msg = `must have at most ${maxQuantity} ${is}`;
	} else {
		msg = "has too many items";
	}

	let actual: unknown = undefined;
	if (actualQuantity >= 0) {
		actual = actualQuantity;
	} else {
		actual = omitValue;
	}

	return new FieldError(errorTypeTooMany, fieldString(path), actual, msg);
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go InternalError.
export function internalError(path: Path | undefined, err: Error): FieldError {
	return new FieldError(errorTypeInternal, fieldString(path), err, err.message);
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go TooShort.
export function tooShort(path: Path | undefined, value: string, minLength: number): FieldError {
	let msg = "";
	if (minLength >= 0) {
		let bs = "characters";
		if (minLength === 1) {
			bs = "character";
		}
		msg = `must be at least ${minLength} ${bs}`;
	} else {
		msg = "value is too short";
	}
	return new FieldError(errorTypeTooShort, fieldString(path), value, msg);
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go NewErrorTypeMatcher.
export function newErrorTypeMatcher(t: ErrorType): Matcher {
	return (err: Error) => err instanceof FieldError && err.type === t;
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorList.
export class ErrorList extends Array<FieldError> {
	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go WithOrigin.
	withOrigin(origin: string): ErrorList {
		for (const err of this) {
			err.origin = origin;
		}
		return this;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go MarkCoveredByDeclarative.
	markCoveredByDeclarative(): ErrorList {
		for (const err of this) {
			err.coveredByDeclarative = true;
		}
		return this;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go PrefixDetail.
	prefixDetail(prefix: string): ErrorList {
		for (const err of this) {
			err.detail = prefix + err.detail;
		}
		return this;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ToAggregate.
	toAggregate(): Error | undefined {
		if (this.length === 0) {
			return undefined;
		}
		const errs: FieldError[] = [];
		const errorMsgs = newString();
		for (const err of this) {
			const msg = err.error();
			if (errorMsgs.has(msg)) {
				continue;
			}
			errorMsgs.insert(msg);
			errs.push(err);
		}
		return newAggregate(errs);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go Filter.
	filter_(...fns: Matcher[]): ErrorList | undefined {
		const err = filterOut(this.toAggregate(), ...fns);
		if (!err) {
			return undefined;
		}
		return fromAggregate(err as Aggregate);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ExtractCoveredByDeclarative.
	extractCoveredByDeclarative(): ErrorList {
		const newList = new ErrorList();
		for (const err of this) {
			if (err.coveredByDeclarative) {
				newList.push(err);
			}
		}
		return newList;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go MarkAlpha.
	markAlpha(): ErrorList {
		for (const err of this) {
			err.validationStabilityLevel = stabilityLevelAlpha;
		}
		return this;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go MarkBeta.
	markBeta(): ErrorList {
		for (const err of this) {
			err.validationStabilityLevel = stabilityLevelBeta;
		}
		return this;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go MarkFromImperative.
	markFromImperative(): ErrorList {
		for (const err of this) {
			err.fromImperative = true;
		}
		return this;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go RemoveCoveredByDeclarative.
	removeCoveredByDeclarative(): ErrorList {
		const newList = new ErrorList();
		for (const err of this) {
			if (!err.coveredByDeclarative) {
				newList.push(err);
			}
		}
		return newList;
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go fromAggregate.
export function fromAggregate(agg: Aggregate): ErrorList {
	const errs = agg.errors;
	const list = new ErrorList();
	for (let i = 0; i < errs.length; i++) {
		list[i] = errs[i] as FieldError;
	}
	return list;
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go TooFew.
export function tooFew(
	path: Path | undefined,
	actualQuantity: number,
	minQuantity: number,
): FieldError {
	let msg = "";

	if (minQuantity >= 0) {
		let is = "items";
		if (minQuantity === 1) {
			is = "item";
		}
		msg = `must have at least ${minQuantity} ${is}`;
	} else {
		msg = "has too few items";
	}

	return new FieldError(errorTypeTooFew, fieldString(path), actualQuantity, msg);
}

function fieldString(path: Path | undefined): string {
	return path?.string() ?? "<nil>";
}
