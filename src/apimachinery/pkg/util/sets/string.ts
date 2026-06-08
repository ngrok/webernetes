// Models staging/src/k8s.io/apimachinery/pkg/util/sets/string.go String.
export class StringSet extends globalThis.Set<string> {
	constructor(items: string[] = []) {
		super();
		this.insert(...items);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/sets/string.go String.Insert.
	insert(...items: string[]): StringSet {
		for (const item of items) {
			this.add(item);
		}
		return this;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/sets/string.go String.Len.
	len(): number {
		return this.size;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/sets/string.go String.List.
	list(): string[] {
		return [...this].sort();
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/util/sets/string.go NewString.
export function newString(...items: string[]): StringSet {
	return new StringSet(items);
}
