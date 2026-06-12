/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1NodeSpec {
	externalID?: string;
	podCIDR?: string;
	podCIDRs?: Array<string>;
	providerID?: string;
	unschedulable?: boolean;
}
