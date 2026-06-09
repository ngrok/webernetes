/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// Models staging/src/k8s.io/component-helpers/node/util/sysctl/sysctl.go NormalizeName.
export function normalizeName(value: string): string {
	if (value === "") {
		return value;
	}
	const firstSepIndex = value.search(/[./]/);
	if (firstSepIndex === -1 || value[firstSepIndex] === ".") {
		return value;
	}
	return [...value]
		.map((char) => {
			switch (char) {
				case ".":
					return "/";
				case "/":
					return ".";
				default:
					return char;
			}
		})
		.join("");
}
