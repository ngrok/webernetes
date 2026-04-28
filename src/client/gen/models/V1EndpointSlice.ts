import { DiscoveryV1EndpointPort } from "./DiscoveryV1EndpointPort";
import { V1Endpoint } from "./V1Endpoint";
import { V1ObjectMeta } from "./V1ObjectMeta";

export interface V1EndpointSlice {
	addressType: string;
	apiVersion?: string;
	endpoints: Array<V1Endpoint>;
	kind?: string;
	metadata?: V1ObjectMeta;
	ports?: Array<DiscoveryV1EndpointPort>;
}
