/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { selectorFromSet, type Selector } from "./selector";

// Models staging/src/k8s.io/apimachinery/pkg/fields/fields.go Fields.
export interface Fields {
	has(field: string): boolean;
	get(field: string): string;
}

// Models staging/src/k8s.io/apimachinery/pkg/fields/fields.go Set.
export class Set implements Fields {
	constructor(readonly fields: Record<string, string> | undefined) {}

	// Models staging/src/k8s.io/apimachinery/pkg/fields/fields.go Set.String.
	string(): string {
		const selector: string[] = [];
		for (const [key, value] of Object.entries(this.fields ?? {})) {
			selector.push(`${key}=${value}`);
		}
		selector.sort();
		return selector.join(",");
	}

	// Models staging/src/k8s.io/apimachinery/pkg/fields/fields.go Set.Has.
	has(field: string): boolean {
		return this.fields !== undefined && field in this.fields;
	}

	// Models staging/src/k8s.io/apimachinery/pkg/fields/fields.go Set.Get.
	get(field: string): string {
		return this.fields?.[field] ?? "";
	}

	// Models staging/src/k8s.io/apimachinery/pkg/fields/fields.go Set.AsSelector.
	asSelector(): Selector {
		return selectorFromSet(this);
	}
}
