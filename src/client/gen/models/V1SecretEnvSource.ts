import { V1LocalObjectReference } from "./V1LocalObjectReference";
export interface V1SecretEnvSource {
	localObjectReference?: V1LocalObjectReference;
	name?: string;
	optional?: boolean;
}
