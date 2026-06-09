/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1Container, V1ObjectReference, V1Pod } from "../../../client";
import { getPartialReference } from "../../../client-go/tools/reference/ref";

// Models kubernetes/pkg/kubelet/container/ref.go ImplicitContainerPrefix.
export const implicitContainerPrefix = "implicitly required container ";

// Models kubernetes/pkg/kubelet/container/ref.go GenerateContainerRef.
export function generateContainerRef(
	pod: V1Pod,
	container: V1Container,
): [V1ObjectReference | undefined, Error | undefined] {
	let [path, err] = fieldPath(pod, container);
	if (err) {
		path = implicitContainerPrefix + container.name;
	}
	const [ref, refErr] = getPartialReference(undefined, pod, path);
	if (refErr) {
		return [undefined, refErr];
	}
	return [ref, undefined];
}

// Models kubernetes/pkg/kubelet/container/ref.go fieldPath.
function fieldPath(pod: V1Pod, container: V1Container): [string, Error | undefined] {
	for (const [i, current] of (pod.spec?.containers ?? []).entries()) {
		if (current.name === container.name) {
			return [
				current.name === "" ? `spec.containers[${i}]` : `spec.containers{${current.name}}`,
				undefined,
			];
		}
	}
	for (const [i, current] of (pod.spec?.initContainers ?? []).entries()) {
		if (current.name === container.name) {
			return [
				current.name === "" ? `spec.initContainers[${i}]` : `spec.initContainers{${current.name}}`,
				undefined,
			];
		}
	}
	for (const [i, current] of (pod.spec?.ephemeralContainers ?? []).entries()) {
		if (current.name === container.name) {
			return [
				current.name === ""
					? `spec.ephemeralContainers[${i}]`
					: `spec.ephemeralContainers{${current.name}}`,
				undefined,
			];
		}
	}
	return [
		"",
		new Error(
			`container ${container.name} not found in pod ${pod.metadata?.namespace}/${pod.metadata?.name}`,
		),
	];
}
