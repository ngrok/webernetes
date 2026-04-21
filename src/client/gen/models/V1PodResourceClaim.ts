import { V1TypedLocalObjectReference } from "./V1TypedLocalObjectReference";
export interface V1PodResourceClaim {
	name: string;
	resourceClaimName?: string;
	resourceClaimTemplateName?: string;
	source?: V1TypedLocalObjectReference;
}
