/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { parseInt } from "../../../go/strconv";
import { podDeletionCost } from "../annotation-key-constants";

// Models kubernetes/pkg/apis/core/helper/helpers.go GetDeletionCostFromPodAnnotations.
export function getDeletionCostFromPodAnnotations(
	annotations: Record<string, string> | undefined,
): [cost: number, err: Error | undefined] {
	const value = annotations?.[podDeletionCost];
	if (value !== undefined) {
		if (!validFirstDigit(value)) {
			return [0, new Error(`invalid value ${JSON.stringify(value)}`)];
		}

		const [i, err] = parseInt(value, 10, 32);
		if (err) {
			return [0, err];
		}
		return [Number(i), undefined];
	}
	return [0, undefined];
}

// Models kubernetes/pkg/apis/core/helper/helpers.go validFirstDigit.
function validFirstDigit(str: string): boolean {
	if (str.length === 0) {
		return false;
	}
	const first = str[0] ?? "";
	return first === "-" || (first === "0" && str === "0") || ("1" <= first && first <= "9");
}
