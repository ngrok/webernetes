/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { KubernetesObject } from "../../../../../client/types";
import type { V1OwnerReference } from "../../../../../client/gen/models";

// Models staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/controller_ref.go GetControllerOf.
export function getControllerOf(controllee: KubernetesObject): V1OwnerReference | undefined {
	const ref = getControllerOfNoCopy(controllee);
	if (!ref) {
		return undefined;
	}
	const cp = { ...ref };
	if (ref.controller !== undefined) {
		cp.controller = ref.controller;
	}
	if (ref.blockOwnerDeletion !== undefined) {
		cp.blockOwnerDeletion = ref.blockOwnerDeletion;
	}
	return cp;
}

// Models staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/controller_ref.go GetControllerOfNoCopy.
export function getControllerOfNoCopy(controllee: KubernetesObject): V1OwnerReference | undefined {
	const refs = controllee.metadata?.ownerReferences ?? [];
	for (const ref of refs) {
		if (ref.controller !== undefined && ref.controller) {
			return ref;
		}
	}
	return undefined;
}
