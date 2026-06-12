/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1AzureDiskVolumeSource {
	cachingMode?: string;
	diskName: string;
	diskURI: string;
	fsType?: string;
	kind?: string;
	readOnly?: boolean;
}
