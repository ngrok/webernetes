/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { emptyError } from "./errors";

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/decimal_int.go decimalIntegerErrMsg.
const decimalIntegerErrMsg = "must be a valid decimal integer in canonical form";

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/decimal_int.go IsDecimalInteger.
export function isDecimalInteger(value: string): string[] {
	const n = value.length;
	if (n === 0) {
		return [emptyError()];
	}

	let i = 0;
	if (value[0] === "-") {
		if (n === 1) {
			return [decimalIntegerErrMsg];
		}
		i = 1;
	}

	if (value[i] === "0") {
		if (n === 1 && i === 0) {
			return [];
		}
		return [decimalIntegerErrMsg];
	}

	if ((value[i] ?? "") < "1" || (value[i] ?? "") > "9") {
		return [decimalIntegerErrMsg];
	}

	for (i++; i < n; i++) {
		if ((value[i] ?? "") < "0" || (value[i] ?? "") > "9") {
			return [decimalIntegerErrMsg];
		}
	}

	return [];
}
