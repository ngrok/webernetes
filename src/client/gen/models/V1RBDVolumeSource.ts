/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1LocalObjectReference } from "./V1LocalObjectReference";
export interface V1RBDVolumeSource {
	fsType?: string;
	image: string;
	keyring?: string;
	monitors: Array<string>;
	pool?: string;
	readOnly?: boolean;
	secretRef?: V1LocalObjectReference;
	user?: string;
}
