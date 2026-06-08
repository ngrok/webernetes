import {
	isLabelValue,
	labelValueMaxLength as contentLabelValueMaxLength,
} from "../../api/validate/content/kube";

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/validation.go dns1123LabelFmt.
const dns1123LabelFmt = "[a-z0-9]([-a-z0-9]*[a-z0-9])?";
const dns1123LabelRegexp = new RegExp(`^${dns1123LabelFmt}$`);
const dns1123LabelErrMsg =
	"a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character";

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/validation.go DNS1123LabelMaxLength.
export const dns1123LabelMaxLength = 63;

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/validation.go dns1123SubdomainFmt.
const dns1123SubdomainFmt = `${dns1123LabelFmt}(\\.${dns1123LabelFmt})*`;
const dns1123SubdomainRegexp = new RegExp(`^${dns1123SubdomainFmt}$`);
const dns1123SubdomainErrorMsg =
	"a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character";

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/validation.go DNS1123SubdomainMaxLength.
export const dns1123SubdomainMaxLength = 253;

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/validation.go MaxLenError.
function maxLenError(length: number): string {
	return `must be no more than ${length} characters`;
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/validation.go RegexError.
function regexError(message: string, format: string, examples: string[]): string {
	if (examples.length === 0) {
		return `${message} (regex used for validation is '${format}')`;
	}
	return `${message} (e.g. ${examples.map((example) => `'${example}', `).join("or ")}regex used for validation is '${format}')`;
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/validation.go IsDNS1123Label.
export function isDNS1123Label(value: string): string[] {
	const errors: string[] = [];
	if (value.length > dns1123LabelMaxLength) {
		errors.push(maxLenError(dns1123LabelMaxLength));
	}
	if (!dns1123LabelRegexp.test(value)) {
		if (dns1123SubdomainRegexp.test(value)) {
			errors.push("must not contain dots");
		} else {
			errors.push(regexError(dns1123LabelErrMsg, dns1123LabelFmt, ["my-name", "123-abc"]));
		}
	}
	return errors;
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/validation.go IsDNS1123Subdomain.
export function isDNS1123Subdomain(value: string): string[] {
	const errors: string[] = [];
	if (value.length > dns1123SubdomainMaxLength) {
		errors.push(maxLenError(dns1123SubdomainMaxLength));
	}
	if (!dns1123SubdomainRegexp.test(value)) {
		errors.push(regexError(dns1123SubdomainErrorMsg, dns1123SubdomainFmt, ["example.com"]));
	}
	return errors;
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/validation.go LabelValueMaxLength.
export const labelValueMaxLength = contentLabelValueMaxLength;

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/validation.go IsValidLabelValue.
export const isValidLabelValue = isLabelValue;
