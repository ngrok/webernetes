/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1AWSElasticBlockStoreVolumeSource {
	fsType?: string;
	partition?: number;
	readOnly?: boolean;
	volumeID: string;
}
