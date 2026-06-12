/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1FCVolumeSource {
	fsType?: string;
	lun?: number;
	readOnly?: boolean;
	targetWWNs?: Array<string>;
	wwids?: Array<string>;
}
