import { V1LocalObjectReference } from "./V1LocalObjectReference";
export interface V1ConfigMapEnvSource {
	localObjectReference?: V1LocalObjectReference;
	name?: string;
	optional?: boolean;
}
