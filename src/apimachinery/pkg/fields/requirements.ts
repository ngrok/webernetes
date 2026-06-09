/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { Operator } from "../selection/operator";

// Models staging/src/k8s.io/apimachinery/pkg/fields/requirements.go Requirements.
export type Requirements = Requirement[] | undefined;

// Models staging/src/k8s.io/apimachinery/pkg/fields/requirements.go Requirement.
export interface Requirement {
	operator: Operator;
	field: string;
	value: string;
}
