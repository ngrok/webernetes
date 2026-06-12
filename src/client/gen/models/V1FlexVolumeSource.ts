/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1LocalObjectReference } from "./V1LocalObjectReference";
export interface V1FlexVolumeSource {
	driver: string;
	fsType?: string;
	options?: {
		[key: string]: string;
	};
	readOnly?: boolean;
	secretRef?: V1LocalObjectReference;
}
