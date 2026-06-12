/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1LocalObjectReference } from "./V1LocalObjectReference";
export interface V1ScaleIOVolumeSource {
	fsType?: string;
	gateway: string;
	protectionDomain?: string;
	readOnly?: boolean;
	secretRef: V1LocalObjectReference;
	sslEnabled?: boolean;
	storageMode?: string;
	storagePool?: string;
	system: string;
	volumeName?: string;
}
