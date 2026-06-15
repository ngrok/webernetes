/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { IntOrString } from "../../../../client";

// Models staging/src/k8s.io/apimachinery/pkg/util/intstr/intstr.go GetScaledValueFromIntOrPercent.
export function getScaledValueFromIntOrPercent(
	intOrPercent: IntOrString | undefined,
	total: number,
	roundUp: boolean,
): [value: number, err: Error | undefined] {
	if (intOrPercent === undefined) {
		return [0, new Error("nil value for IntOrString")];
	}
	const [value, isPercent, err] = getIntOrPercentValueSafely(intOrPercent);
	if (err) {
		return [0, new Error(`invalid value for IntOrString: ${err.message}`)];
	}
	if (isPercent) {
		if (roundUp) {
			return [Math.ceil((value * total) / 100), undefined];
		}
		return [Math.floor((value * total) / 100), undefined];
	}
	return [value, undefined];
}

// Models staging/src/k8s.io/apimachinery/pkg/util/intstr/intstr.go getIntOrPercentValueSafely.
export function getIntOrPercentValueSafely(
	intOrPercent: IntOrString,
): [value: number, isPercent: boolean, err: Error | undefined] {
	if (typeof intOrPercent === "number") {
		return [intOrPercent, false, undefined];
	}
	let isPercent = false;
	let value = intOrPercent;
	if (intOrPercent.endsWith("%")) {
		isPercent = true;
		value = intOrPercent.slice(0, -1);
	} else {
		return [0, false, new Error("invalid type: string is not a percentage")];
	}
	if (!/^[+-]?\d+$/.test(value)) {
		return [0, false, new Error(`invalid value "${intOrPercent}"`)];
	}
	return [Number(value), isPercent, undefined];
}
