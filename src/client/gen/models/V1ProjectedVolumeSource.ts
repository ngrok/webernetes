/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1VolumeProjection } from "./V1VolumeProjection";
export interface V1ProjectedVolumeSource {
	defaultMode?: number;
	sources?: Array<V1VolumeProjection>;
}
