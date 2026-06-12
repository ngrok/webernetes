/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1NodeAllocatableResourceClaimStatus {
	containers?: Array<string>;
	resourceClaimName: string;
	resources: { [key: string]: string };
}
