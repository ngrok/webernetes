/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/errors.go MinError.
export function minError(min: number): string {
	return `must be greater than or equal to ${min}`;
}

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/errors.go MaxError.
export function maxError(max: number): string {
	return `must be less than or equal to ${max}`;
}

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/errors.go MaxLenError.
export function maxLenError(length: number): string {
	return `must be no more than ${length} bytes`;
}

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/errors.go EmptyError.
export function emptyError(): string {
	return "must be non-empty";
}

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/errors.go RegexError.
export function regexError(msg: string, re: string, ...examples: string[]): string {
	if (examples.length === 0) {
		return `${msg} (regex used for validation is '${re}')`;
	}
	msg += " (e.g. ";
	for (let i = 0; i < examples.length; i++) {
		if (i > 0) {
			msg += " or ";
		}
		msg += `'${examples[i]}', `;
	}
	msg += `regex used for validation is '${re}')`;
	return msg;
}

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/errors.go NEQError.
export function neqError(disallowed: unknown): string {
	let format = "%v";
	if (typeof disallowed === "string") {
		format = "%q";
	}
	return `must not be equal to ${format === "%q" ? JSON.stringify(disallowed) : String(disallowed)}`;
}
