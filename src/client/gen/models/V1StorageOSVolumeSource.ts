/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1LocalObjectReference } from "./V1LocalObjectReference";
export interface V1StorageOSVolumeSource {
	fsType?: string;
	readOnly?: boolean;
	secretRef?: V1LocalObjectReference;
	volumeName?: string;
	volumeNamespace?: string;
}
