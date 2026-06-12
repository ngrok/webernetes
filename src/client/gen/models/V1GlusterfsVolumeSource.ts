/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1GlusterfsVolumeSource {
	endpoints: string;
	path: string;
	readOnly?: boolean;
}
