/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1LabelSelector } from "../../../../../client";
import {
	everything,
	newRequirement,
	newSelector,
	nothing,
	type Requirement,
	type Selector,
} from "../../../labels/selector";
import {
	doesNotExist,
	equals,
	exists,
	inOperator,
	notIn,
	type Operator,
} from "../../../selection/operator";

// Models staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/helpers.go LabelSelectorAsSelector.
export function labelSelectorAsSelector(
	ps: V1LabelSelector | undefined,
): [selector: Selector | undefined, err: Error | undefined] {
	if (!ps) {
		return [nothing(), undefined];
	}
	if (Object.keys(ps.matchLabels ?? {}).length + (ps.matchExpressions ?? []).length === 0) {
		return [everything(), undefined];
	}
	const requirements: Requirement[] = [];
	for (const [key, value] of Object.entries(ps.matchLabels ?? {})) {
		const [requirement, err] = newRequirement(key, equals, [value]);
		if (err || !requirement) {
			return [undefined, err];
		}
		requirements.push(requirement);
	}
	for (const expr of ps.matchExpressions ?? []) {
		let op: Operator;
		switch (expr.operator) {
			case "In":
				op = inOperator;
				break;
			case "NotIn":
				op = notIn;
				break;
			case "Exists":
				op = exists;
				break;
			case "DoesNotExist":
				op = doesNotExist;
				break;
			default:
				return [undefined, new Error(`"${expr.operator}" is not a valid label selector operator`)];
		}
		const [requirement, err] = newRequirement(expr.key, op, [...(expr.values ?? [])]);
		if (err || !requirement) {
			return [undefined, err];
		}
		requirements.push(requirement);
	}
	return [newSelector().add(...requirements), undefined];
}
