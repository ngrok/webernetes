/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { maxLenError, regexError } from "./errors";

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns.go dns1123LabelFmt.
const dns1123LabelFmt = "[a-z0-9]([-a-z0-9]*[a-z0-9])?";

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns.go dns1123LabelErrMsg.
const dns1123LabelErrMsg =
	"a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character";

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns.go DNS1123LabelMaxLength.
export const dns1123LabelMaxLength = 63;

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns.go dns1123LabelRegexp.
const dns1123LabelRegexp = new RegExp(`^${dns1123LabelFmt}$`);

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns.go IsDNS1123Label.
export function isDNS1123Label(value: string): string[] {
	const errs: string[] = [];
	if (value.length > dns1123LabelMaxLength) {
		errs.push(maxLenError(dns1123LabelMaxLength));
	}
	if (!dns1123LabelRegexp.test(value)) {
		if (dns1123SubdomainRegexp.test(value)) {
			errs.push("must not contain dots");
		} else {
			errs.push(regexError(dns1123LabelErrMsg, dns1123LabelFmt, "my-name", "123-abc"));
		}
	}
	return errs;
}

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns.go dns1123SubdomainFmt.
const dns1123SubdomainFmt = `${dns1123LabelFmt}(\\.${dns1123LabelFmt})*`;

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns.go dns1123SubdomainFmtCaseless.
const dns1123SubdomainFmtCaseless = dns1123SubdomainFmt;

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns.go dns1123SubdomainErrorMsg.
const dns1123SubdomainErrorMsg =
	"a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character";

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns.go dns1123SubdomainCaselessErrorMsg.
const dns1123SubdomainCaselessErrorMsg =
	"an RFC 1123 subdomain must consist of alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character";

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns.go DNS1123SubdomainMaxLength.
export const dns1123SubdomainMaxLength = 253;

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns.go dns1123SubdomainRegexp.
const dns1123SubdomainRegexp = new RegExp(`^${dns1123SubdomainFmt}$`);

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns.go dns1123SubdomainCaselessRegexp.
const dns1123SubdomainCaselessRegexp = new RegExp(`^${dns1123SubdomainFmtCaseless}$`, "i");

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns.go IsDNS1123Subdomain.
export function isDNS1123Subdomain(value: string): string[] {
	return isDNS1123SubdomainInternal(value, false);
}

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns.go IsDNS1123SubdomainCaseless.
export function isDNS1123SubdomainCaseless(value: string): string[] {
	return isDNS1123SubdomainInternal(value, true);
}

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/dns.go isDNS1123Subdomain.
function isDNS1123SubdomainInternal(value: string, caseless: boolean): string[] {
	const errs: string[] = [];
	if (value.length > dns1123SubdomainMaxLength) {
		errs.push(maxLenError(dns1123SubdomainMaxLength));
	}
	let errorMsg = dns1123SubdomainErrorMsg;
	let example = "example.com";
	let regexp = dns1123SubdomainRegexp;
	if (caseless) {
		errorMsg = dns1123SubdomainCaselessErrorMsg;
		example = "Example.com";
		regexp = dns1123SubdomainCaselessRegexp;
	}
	if (!regexp.test(value)) {
		errs.push(regexError(errorMsg, dns1123SubdomainFmt, example));
	}
	return errs;
}
