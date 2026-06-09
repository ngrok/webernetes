/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// Models staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go GroupKind.
export class GroupKind {
	constructor(
		readonly group: string,
		readonly kind: string,
	) {}

	// Models staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go GroupKind.Empty.
	empty(): boolean {
		return this.group.length === 0 && this.kind.length === 0;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go GroupKind.WithVersion.
	withVersion(version: string): GroupVersionKind {
		return new GroupVersionKind(this.group, version, this.kind);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go GroupKind.String.
	toString(): string {
		if (this.group.length === 0) {
			return this.kind;
		}
		return `${this.kind}.${this.group}`;
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go GroupVersionKind.
export class GroupVersionKind {
	constructor(
		readonly group: string,
		readonly version: string,
		readonly kind: string,
	) {}

	// Models staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go GroupVersionKind.Empty.
	empty(): boolean {
		return this.group.length === 0 && this.version.length === 0 && this.kind.length === 0;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go GroupVersionKind.GroupKind.
	groupKind(): GroupKind {
		return new GroupKind(this.group, this.kind);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go GroupVersionKind.String.
	toString(): string {
		return `${this.group}/${this.version}, Kind=${this.kind}`;
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go GroupVersion.
export class GroupVersion {
	constructor(
		readonly group: string,
		readonly version: string,
	) {}

	// Models staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go GroupVersion.Empty.
	empty(): boolean {
		return this.group.length === 0 && this.version.length === 0;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go GroupVersion.String.
	toString(): string {
		if (this.group.length > 0) {
			return `${this.group}/${this.version}`;
		}
		return this.version;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go GroupVersion.WithKind.
	withKind(kind: string): GroupVersionKind {
		return new GroupVersionKind(this.group, this.version, kind);
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go ParseGroupVersion.
export function parseGroupVersion(gv: string): [GroupVersion, Error | undefined] {
	if (gv.length === 0 || gv === "/") {
		return [new GroupVersion("", ""), undefined];
	}
	const parts = gv.split("/");
	switch (parts.length) {
		case 1:
			return [new GroupVersion("", gv), undefined];
		case 2:
			return [new GroupVersion(parts[0] ?? "", parts[1] ?? ""), undefined];
		default:
			return [new GroupVersion("", ""), new Error(`unexpected GroupVersion string: ${gv}`)];
	}
}

// Models staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go FromAPIVersionAndKind.
export function fromAPIVersionAndKind(apiVersion: string, kind: string): GroupVersionKind {
	const [gv, err] = parseGroupVersion(apiVersion);
	if (!err) {
		return new GroupVersionKind(gv.group, gv.version, kind);
	}
	return new GroupVersionKind("", "", kind);
}
