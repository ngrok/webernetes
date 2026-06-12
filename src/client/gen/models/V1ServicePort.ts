/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1ServicePort {
	appProtocol?: string;
	name?: string;
	nodePort?: number;
	port: number;
	protocol?: string;
	targetPort?: number | string;
}
