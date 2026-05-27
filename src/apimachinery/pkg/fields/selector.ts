// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go Selector.
export interface Selector {
	string(): string;
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go Everything.
export function everything(): Selector {
	return new AndTerm();
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/selector.go andTerm.
class AndTerm implements Selector {
	string(): string {
		return "";
	}
}
