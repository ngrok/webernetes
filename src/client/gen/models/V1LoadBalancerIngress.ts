/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1PortStatus } from "./V1PortStatus";

export interface V1LoadBalancerIngress {
	hostname?: string;
	ip?: string;
	ipMode?: string;
	ports?: Array<V1PortStatus>;
}
