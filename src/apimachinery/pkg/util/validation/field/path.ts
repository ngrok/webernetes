/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/path.go pathOptions.
class PathOptions {
	path: Path | undefined;
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/path.go PathOption.
export type PathOption = (options: PathOptions) => void;

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/path.go WithPath.
export function withPath(path: Path | undefined): PathOption {
	return (options) => {
		options.path = path;
	};
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/path.go ToPath.
export function toPath(...opts: PathOption[]): Path | undefined {
	const options = new PathOptions();
	for (const opt of opts) {
		opt(options);
	}
	return options.path;
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/path.go Path.
export class Path {
	constructor(
		private readonly name: string,
		private readonly indexValue: string,
		private parent: Path | undefined,
	) {}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/path.go Root.
	root(): Path {
		let result: Path = this;
		for (; result.parent !== undefined; result = result.parent) {}
		return result;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/path.go Child.
	child(name: string, ...moreNames: string[]): Path {
		const r = newPath(name, ...moreNames);
		r.root().parent = this;
		return r;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/path.go Index.
	index(index: number): Path {
		return new Path("", String(index), this);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/path.go Key.
	key(key: string): Path {
		return new Path("", key, this);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/path.go String.
	string(): string {
		const elems: Path[] = [];
		for (let p: Path | undefined = this; p !== undefined; p = p.parent) {
			elems.push(p);
		}

		let out = "";
		for (let i = elems.length - 1; i >= 0; i--) {
			const p = elems[i] as Path;
			if (p.parent !== undefined && p.name.length > 0) {
				out += ".";
			}
			if (p.name.length > 0) {
				out += p.name;
			} else {
				out += `[${p.indexValue}]`;
			}
		}
		return out;
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/util/validation/field/path.go NewPath.
export function newPath(name: string, ...moreNames: string[]): Path {
	let result = new Path(name, "", undefined);
	for (const anotherName of moreNames) {
		result = new Path(anotherName, "", result);
	}
	return result;
}

export function childPath(path: Path | undefined, name: string): Path {
	return path ? path.child(name) : newPath(name);
}
