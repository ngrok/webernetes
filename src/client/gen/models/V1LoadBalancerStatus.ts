import { V1LoadBalancerIngress } from "./V1LoadBalancerIngress";

export interface V1LoadBalancerStatus {
	ingress?: Array<V1LoadBalancerIngress>;
}
