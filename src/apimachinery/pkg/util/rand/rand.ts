/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
const alphanums = "bcdfghjklmnpqrstvwxz2456789";

// Models staging/src/k8s.io/apimachinery/pkg/util/rand/rand.go SafeEncodeString.
export function safeEncodeString(s: string): string {
	let encoded = "";
	for (const char of s) {
		// oxlint-disable-next-line typescript/no-non-null-assertion
		encoded += alphanums[char.codePointAt(0)! % alphanums.length] ?? "";
	}
	return encoded;
}
