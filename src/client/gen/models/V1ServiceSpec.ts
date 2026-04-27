import { V1ServicePort } from "./V1ServicePort";

export interface V1ServiceSpec {
	allocateLoadBalancerNodePorts?: boolean;
	clusterIP?: string;
	clusterIPs?: Array<string>;
	externalIPs?: Array<string>;
	externalName?: string;
	externalTrafficPolicy?: string;
	healthCheckNodePort?: number;
	internalTrafficPolicy?: string;
	ipFamilies?: Array<string>;
	ipFamilyPolicy?: string;
	loadBalancerClass?: string;
	loadBalancerIP?: string;
	loadBalancerSourceRanges?: Array<string>;
	ports?: Array<V1ServicePort>;
	publishNotReadyAddresses?: boolean;
	selector?: {
		[key: string]: string;
	};
	sessionAffinity?: string;
	trafficDistribution?: string;
	type?: string;
}
