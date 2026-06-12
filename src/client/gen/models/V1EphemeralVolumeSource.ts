/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1PersistentVolumeClaimTemplate } from "./V1PersistentVolumeClaimTemplate";
export interface V1EphemeralVolumeSource {
	volumeClaimTemplate?: V1PersistentVolumeClaimTemplate;
}
