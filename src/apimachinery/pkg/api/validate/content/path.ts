/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/path.go pathSegmentNameMayNotBe.
const pathSegmentNameMayNotBe = [".", ".."];

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/path.go pathSegmentNameMayNotContain.
const pathSegmentNameMayNotContain = ["/", "%"];

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/path.go IsPathSegmentName.
export function isPathSegmentName(name: string): string[] {
	for (const illegalName of pathSegmentNameMayNotBe) {
		if (name === illegalName) {
			return [`may not be '${illegalName}'`];
		}
	}

	return isPathSegmentPrefix(name);
}

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/path.go IsPathSegmentPrefix.
export function isPathSegmentPrefix(name: string): string[] {
	const errors: string[] = [];
	for (const illegalContent of pathSegmentNameMayNotContain) {
		if (name.includes(illegalContent)) {
			errors.push(`may not contain '${illegalContent}'`);
		}
	}

	return errors;
}
