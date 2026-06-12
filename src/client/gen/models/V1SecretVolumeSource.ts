/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1KeyToPath } from "./V1KeyToPath";
export interface V1SecretVolumeSource {
	defaultMode?: number;
	items?: Array<V1KeyToPath>;
	optional?: boolean;
	secretName?: string;
}
