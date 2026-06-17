/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */

// Models staging/src/k8s.io/apimachinery/pkg/types/namespacedname.go NamespacedName.
export interface NamespacedName {
	namespace: string;
	name: string;
}

// Models staging/src/k8s.io/apimachinery/pkg/types/namespacedname.go Separator.
export const separator = "/";

// Models staging/src/k8s.io/apimachinery/pkg/types/namespacedname.go NamespacedName.String.
export function namespacedNameString(n: NamespacedName): string {
	return n.namespace + separator + n.name;
}
