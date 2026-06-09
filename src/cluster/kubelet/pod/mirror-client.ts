/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1Pod } from "../../../client";
import * as kubetypes from "../types";

// Models kubernetes/pkg/kubelet/pod/mirror_client.go getHashFromMirrorPod.
export function getHashFromMirrorPod(pod: V1Pod): string | undefined {
	return pod.metadata?.annotations?.[kubetypes.configMirrorAnnotationKey];
}

// Models kubernetes/pkg/kubelet/pod/mirror_client.go getPodHash.
export function getPodHash(pod: V1Pod): string | undefined {
	// The annotation exists for all static pods.
	return pod.metadata?.annotations?.[kubetypes.configHashAnnotationKey];
}
