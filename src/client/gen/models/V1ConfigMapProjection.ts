import { V1KeyToPath } from "./V1KeyToPath";
import { V1LocalObjectReference } from "./V1LocalObjectReference";
export interface V1ConfigMapProjection {
	items?: Array<V1KeyToPath>;
	localObjectReference?: V1LocalObjectReference;
	name?: string;
	optional?: boolean;
}
