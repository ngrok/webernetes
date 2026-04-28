import { V1EndpointConditions } from "./V1EndpointConditions";
import { V1EndpointHints } from "./V1EndpointHints";
import { V1ObjectReference } from "./V1ObjectReference";

export interface V1Endpoint {
	addresses: Array<string>;
	conditions?: V1EndpointConditions;
	deprecatedTopology?: {
		[key: string]: string;
	};
	hints?: V1EndpointHints;
	hostname?: string;
	nodeName?: string;
	targetRef?: V1ObjectReference;
	zone?: string;
}
