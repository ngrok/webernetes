/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1QuobyteVolumeSource {
	group?: string;
	readOnly?: boolean;
	registry: string;
	tenant?: string;
	user?: string;
	volume: string;
}
