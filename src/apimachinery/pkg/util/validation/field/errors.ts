import type { Path } from "./path";

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go ErrorType.
export type ErrorType = "FieldValueInvalid";

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go Error.
export class FieldError extends Error {
	constructor(
		readonly type: ErrorType,
		readonly field: string,
		readonly badValue: unknown,
		readonly detail: string,
	) {
		super(`${field}: ${fieldErrorTypeString(type)}: ${JSON.stringify(badValue)}: ${detail}`);
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/errors.go Invalid.
export function invalid(path: Path | undefined, value: unknown, detail: string): FieldError {
	return new FieldError("FieldValueInvalid", path?.string() ?? "<nil>", value, detail);
}

function fieldErrorTypeString(type: ErrorType): string {
	switch (type) {
		case "FieldValueInvalid":
			return "Invalid value";
	}
}
