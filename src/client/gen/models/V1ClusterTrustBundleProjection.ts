/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1LabelSelector } from "./V1LabelSelector";
export interface V1ClusterTrustBundleProjection {
	labelSelector?: V1LabelSelector;
	name?: string;
	optional?: boolean;
	path: string;
	signerName?: string;
}
