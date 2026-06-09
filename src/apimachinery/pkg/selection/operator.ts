/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// Models staging/src/k8s.io/apimachinery/pkg/selection/operator.go Operator.
export type Operator = "!" | "=" | "==" | "in" | "!=" | "notin" | "exists" | "gt" | "lt";

// Models staging/src/k8s.io/apimachinery/pkg/selection/operator.go DoesNotExist.
export const doesNotExist: Operator = "!";

// Models staging/src/k8s.io/apimachinery/pkg/selection/operator.go Equals.
export const equals: Operator = "=";

// Models staging/src/k8s.io/apimachinery/pkg/selection/operator.go DoubleEquals.
export const doubleEquals: Operator = "==";

// Models staging/src/k8s.io/apimachinery/pkg/selection/operator.go In.
export const inOperator: Operator = "in";

// Models staging/src/k8s.io/apimachinery/pkg/selection/operator.go NotEquals.
export const notEquals: Operator = "!=";

// Models staging/src/k8s.io/apimachinery/pkg/selection/operator.go NotIn.
export const notIn: Operator = "notin";

// Models staging/src/k8s.io/apimachinery/pkg/selection/operator.go Exists.
export const exists: Operator = "exists";

// Models staging/src/k8s.io/apimachinery/pkg/selection/operator.go GreaterThan.
export const greaterThan: Operator = "gt";

// Models staging/src/k8s.io/apimachinery/pkg/selection/operator.go LessThan.
export const lessThan: Operator = "lt";
