/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1ConfigMapNodeConfigSource {
	kubeletConfigKey: string;
	name: string;
	namespace: string;
	resourceVersion?: string;
	uid?: string;
}
