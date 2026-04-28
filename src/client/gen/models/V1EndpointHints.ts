import { V1ForNode } from "./V1ForNode";
import { V1ForZone } from "./V1ForZone";

export interface V1EndpointHints {
	forNodes?: Array<V1ForNode>;
	forZones?: Array<V1ForZone>;
}
