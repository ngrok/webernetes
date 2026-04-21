export interface V1PodCertificateProjection {
	credentialBundlePath: string;
	keyType?: string;
	maxExpirationSeconds?: number;
	path: string;
	signerName: string;
}
