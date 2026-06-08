import { regexError } from "./errors";

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/identifier.go cIdentifierFmt.
const cIdentifierFmt = "[A-Za-z_][A-Za-z0-9_]*";
// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/identifier.go identifierErrMsg.
const identifierErrMsg =
	"a valid C identifier must start with alphabetic character or '_', followed by a string of alphanumeric characters or '_'";

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/identifier.go cIdentifierRegexp.
const cIdentifierRegexp = new RegExp(`^${cIdentifierFmt}$`);

// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/identifier.go IsCIdentifier.
export function isCIdentifier(value: string): string[] {
	if (!cIdentifierRegexp.test(value)) {
		return [regexError(identifierErrMsg, cIdentifierFmt, "my_name", "MY_NAME", "MyName")];
	}
	return [];
}
