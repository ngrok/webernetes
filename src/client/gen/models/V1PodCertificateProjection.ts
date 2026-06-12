/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1PodCertificateProjection {
	certificateChainPath?: string;
	credentialBundlePath?: string;
	keyPath?: string;
	keyType: string;
	maxExpirationSeconds?: number;
	signerName: string;
}
