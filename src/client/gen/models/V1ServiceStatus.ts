/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1Condition } from "./V1Condition";
import { V1LoadBalancerStatus } from "./V1LoadBalancerStatus";

export interface V1ServiceStatus {
	conditions?: Array<V1Condition>;
	loadBalancer?: V1LoadBalancerStatus;
}
