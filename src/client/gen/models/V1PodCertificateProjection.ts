export interface V1PodCertificateProjection {
	certificateChainPath?: string;
	credentialBundlePath?: string;
	keyPath?: string;
	keyType: string;
	maxExpirationSeconds?: number;
	signerName: string;
}
