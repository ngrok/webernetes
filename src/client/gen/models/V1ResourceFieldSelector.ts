/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1ResourceFieldSelector {
	containerName?: string;
	divisor?: string;
	resource: string;
}
