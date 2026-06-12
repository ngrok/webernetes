/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface DiscoveryV1EndpointPort {
	appProtocol?: string;
	name?: string;
	port?: number;
	protocol?: string;
}
