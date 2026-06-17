/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { isDNS1123Subdomain } from "../validate/content/dns";

// Models staging/src/k8s.io/apimachinery/pkg/api/validation/generic.go NameIsDNSSubdomain.
export function nameIsDNSSubdomain(name: string, prefix: boolean): string[] {
	if (prefix) {
		name = maskTrailingDash(name);
	}
	return isDNS1123Subdomain(name);
}

// Models staging/src/k8s.io/apimachinery/pkg/api/validation/generic.go maskTrailingDash.
function maskTrailingDash(name: string): string {
	if (name.length > 1 && name.endsWith("-")) {
		return `${name.slice(0, -2)}a`;
	}
	return name;
}
