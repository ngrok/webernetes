/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */

// Models staging/src/k8s.io/apimachinery/pkg/util/resourceversion/resourceversion.go InvalidResourceVersion.
export class InvalidResourceVersion extends Error {
	constructor(readonly rv: string) {
		super(`resource version is not well formed: ${rv}`);
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/util/resourceversion/resourceversion.go CompareResourceVersion.
export function compareResourceVersion(a: string, b: string): [number, Error | undefined] {
	if (!isWellFormed(a)) {
		return [0, new InvalidResourceVersion(a)];
	}
	if (!isWellFormed(b)) {
		return [0, new InvalidResourceVersion(b)];
	}
	if (a.length < b.length) {
		return [-1, undefined];
	}
	if (a.length > b.length) {
		return [1, undefined];
	}
	return [a.localeCompare(b), undefined];
}

// Models staging/src/k8s.io/apimachinery/pkg/util/resourceversion/resourceversion.go isWellFormed.
function isWellFormed(s: string): boolean {
	if (s.length === 0) {
		return false;
	}
	if (s[0] === "0") {
		return false;
	}
	for (const char of s) {
		if (char < "0" || char > "9") {
			return false;
		}
	}
	return true;
}
