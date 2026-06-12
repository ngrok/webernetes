/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1WindowsSecurityContextOptions {
	gmsaCredentialSpec?: string;
	gmsaCredentialSpecName?: string;
	hostProcess?: boolean;
	runAsUserName?: string;
}
