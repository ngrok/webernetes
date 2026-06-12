/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1TypedLocalObjectReference {
	apiGroup?: string;
	kind: string;
	name: string;
}
