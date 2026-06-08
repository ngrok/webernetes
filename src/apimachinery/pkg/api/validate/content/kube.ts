import { isDNS1123Subdomain } from "./dns";
import { emptyError, maxLenError, regexError } from "./errors";

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/kube.go labelKeyCharFmt.
const labelKeyCharFmt = "[A-Za-z0-9]";
// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/kube.go labelKeyExtCharFmt.
const labelKeyExtCharFmt = "[-A-Za-z0-9_.]";
// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/kube.go labelKeyFmt.
const labelKeyFmt = `(${labelKeyCharFmt}${labelKeyExtCharFmt}*)?${labelKeyCharFmt}`;
// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/kube.go labelKeyErrMsg.
const labelKeyErrMsg =
	"must consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character";
// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/kube.go labelKeyMaxLength.
const labelKeyMaxLength = 63;

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/kube.go labelKeyRegexp.
const labelKeyRegexp = new RegExp(`^${labelKeyFmt}$`);

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/kube.go IsQualifiedName.
export const isQualifiedName = isLabelKey;

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/kube.go IsLabelKey.
export function isLabelKey(value: string): string[] {
	const errs: string[] = [];
	const parts = value.split("/");
	let name = "";
	switch (parts.length) {
		case 1:
			name = parts[0] ?? "";
			break;
		case 2: {
			let prefix = "";
			prefix = parts[0] ?? "";
			name = parts[1] ?? "";
			if (prefix.length === 0) {
				errs.push(`prefix part ${emptyError()}`);
			} else {
				const msgs = isDNS1123Subdomain(prefix);
				if (msgs.length !== 0) {
					errs.push(...prefixEach(msgs, "prefix part "));
				}
			}
			break;
		}
		default:
			return [
				...errs,
				`a valid label key ${regexError(labelKeyErrMsg, labelKeyFmt, "MyName", "my.name", "123-abc")} with an optional DNS subdomain prefix and '/' (e.g. 'example.com/MyName')`,
			];
	}

	if (name.length === 0) {
		errs.push(`name part ${emptyError()}`);
	} else if (name.length > labelKeyMaxLength) {
		errs.push(`name part ${maxLenError(labelKeyMaxLength)}`);
	}
	if (!labelKeyRegexp.test(name)) {
		errs.push(
			`name part ${regexError(labelKeyErrMsg, labelKeyFmt, "MyName", "my.name", "123-abc")}`,
		);
	}
	return errs;
}

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/kube.go labelValueFmt.
const labelValueFmt = `(${labelKeyFmt})?`;
// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/kube.go labelValueErrMsg.
const labelValueErrMsg =
	"a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character";

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/kube.go LabelValueMaxLength.
export const labelValueMaxLength = 63;

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/kube.go labelValueRegexp.
const labelValueRegexp = new RegExp(`^${labelValueFmt}$`);

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/kube.go IsLabelValue.
export function isLabelValue(value: string): string[] {
	const errs: string[] = [];
	if (value.length > labelValueMaxLength) {
		errs.push(maxLenError(labelValueMaxLength));
	}
	if (!labelValueRegexp.test(value)) {
		errs.push(regexError(labelValueErrMsg, labelValueFmt, "MyValue", "my_value", "12345"));
	}
	return errs;
}

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/kube.go prefixEach.
function prefixEach(msgs: string[], prefix: string): string[] {
	for (let i = 0; i < msgs.length; i++) {
		msgs[i] = prefix + msgs[i];
	}
	return msgs;
}
