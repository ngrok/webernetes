/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1Capabilities {
	add?: Array<string>;
	drop?: Array<string>;
}
