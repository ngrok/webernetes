import { V1KeyToPath } from "./V1KeyToPath";
import { V1LocalObjectReference } from "./V1LocalObjectReference";
export interface V1ConfigMapVolumeSource {
	defaultMode?: number;
	items?: Array<V1KeyToPath>;
	localObjectReference?: V1LocalObjectReference;
	name?: string;
	optional?: boolean;
}
