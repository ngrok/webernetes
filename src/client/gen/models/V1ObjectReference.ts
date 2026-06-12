/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1ObjectReference {
	apiVersion?: string;
	fieldPath?: string;
	kind?: string;
	name?: string;
	namespace?: string;
	resourceVersion?: string;
	uid?: string;
}
