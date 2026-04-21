import { V1LocalObjectReference } from "./V1LocalObjectReference";
export interface V1ConfigMapKeySelector {
	key: string;
	localObjectReference?: V1LocalObjectReference;
	name?: string;
	optional?: boolean;
}
