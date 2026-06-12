/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1ClusterTrustBundleProjection } from "./V1ClusterTrustBundleProjection";
import { V1ConfigMapProjection } from "./V1ConfigMapProjection";
import { V1DownwardAPIProjection } from "./V1DownwardAPIProjection";
import { V1PodCertificateProjection } from "./V1PodCertificateProjection";
import { V1SecretProjection } from "./V1SecretProjection";
import { V1ServiceAccountTokenProjection } from "./V1ServiceAccountTokenProjection";
export interface V1VolumeProjection {
	clusterTrustBundle?: V1ClusterTrustBundleProjection;
	configMap?: V1ConfigMapProjection;
	downwardAPI?: V1DownwardAPIProjection;
	podCertificate?: V1PodCertificateProjection;
	secret?: V1SecretProjection;
	serviceAccountToken?: V1ServiceAccountTokenProjection;
}
