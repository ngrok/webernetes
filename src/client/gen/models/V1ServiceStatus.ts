/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1ServiceStatus {
	conditions?: Array<unknown>;
	loadBalancer?: unknown;
}
