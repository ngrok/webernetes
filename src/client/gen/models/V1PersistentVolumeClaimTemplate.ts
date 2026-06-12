/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1ObjectMeta } from "./V1ObjectMeta";
import { V1PersistentVolumeClaimSpec } from "./V1PersistentVolumeClaimSpec";
export interface V1PersistentVolumeClaimTemplate {
	metadata?: V1ObjectMeta;
	spec: V1PersistentVolumeClaimSpec;
}
