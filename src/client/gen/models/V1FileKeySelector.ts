/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1FileKeySelector {
	key: string;
	optional?: boolean;
	path: string;
	volumeName: string;
}
