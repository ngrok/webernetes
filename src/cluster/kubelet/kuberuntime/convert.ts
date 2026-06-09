/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { Image as ImageFromCRI, ImageSpec as ImageSpecFromCRI } from "../../cri";
import type { ImageSpec } from "../container";

// Models kubernetes/pkg/kubelet/kuberuntime/convert.go ToKubeContainerImageSpec.
export function toKubeContainerImageSpec(image: ImageFromCRI): ImageSpec {
	const annotations = Object.entries(image.spec?.annotations ?? {})
		.toSorted(([left], [right]) => left.localeCompare(right))
		.map(([name, value]) => ({ name, value }));
	return {
		image: image.id,
		runtimeHandler: image.spec?.runtimeHandler ?? "",
		annotations,
	};
}

// Models kubernetes/pkg/kubelet/kuberuntime/convert.go ToRuntimeAPIImageSpec.
export function toRuntimeAPIImageSpec(image: ImageSpec): ImageSpecFromCRI {
	return {
		image: image.image,
		runtimeHandler: image.runtimeHandler,
		annotations: Object.fromEntries(
			(image.annotations ?? []).map((annotation) => [annotation.name, annotation.value]),
		),
	};
}
