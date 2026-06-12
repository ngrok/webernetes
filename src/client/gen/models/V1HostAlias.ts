/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1HostAlias {
	hostnames?: Array<string>;
	ip: string;
}
