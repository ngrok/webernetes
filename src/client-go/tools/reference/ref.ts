/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1ObjectReference } from "../../../client";
import type { KubernetesObject } from "../../../client/types";

type RuntimeObject = KubernetesObject | V1ObjectReference | undefined;

// Models staging/src/k8s.io/client-go/tools/reference/ref.go ErrNilObject.
export const errNilObject = new Error("can't reference a nil object");

// Models staging/src/k8s.io/client-go/tools/reference/ref.go GetReference.
export function getReference(
	_scheme: unknown,
	obj: RuntimeObject,
): [V1ObjectReference | undefined, Error | undefined] {
	if (obj === undefined) {
		return [undefined, errNilObject];
	}
	if (isObjectReference(obj)) {
		return [obj, undefined];
	}

	const objectMeta = obj.metadata;
	if (objectMeta === undefined) {
		return [undefined, new Error("object metadata is required")];
	}

	const kind = obj.kind;
	const version = obj.apiVersion;

	if (!kind || !version) {
		return [undefined, new Error("scheme is required to look up gvk")];
	}

	return [
		{
			kind,
			apiVersion: version,
			name: objectMeta.name,
			namespace: objectMeta.namespace,
			uid: objectMeta.uid,
			resourceVersion: objectMeta.resourceVersion,
		},
		undefined,
	];
}

// Models staging/src/k8s.io/client-go/tools/reference/ref.go GetPartialReference.
export function getPartialReference(
	scheme: unknown,
	obj: RuntimeObject,
	fieldPath: string,
): [V1ObjectReference | undefined, Error | undefined] {
	const [ref, err] = getReference(scheme, obj);
	if (err) {
		return [undefined, err];
	}
	if (ref) {
		ref.fieldPath = fieldPath;
	}
	return [ref, undefined];
}

function isObjectReference(obj: RuntimeObject): obj is V1ObjectReference {
	return obj !== undefined && !("metadata" in obj);
}
