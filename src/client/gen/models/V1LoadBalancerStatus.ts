/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1LoadBalancerIngress } from "./V1LoadBalancerIngress";

export interface V1LoadBalancerStatus {
	ingress?: Array<V1LoadBalancerIngress>;
}
