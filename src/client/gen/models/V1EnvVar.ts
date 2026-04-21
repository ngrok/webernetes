import { V1EnvVarSource } from "./V1EnvVarSource";
export interface V1EnvVar {
	name: string;
	value?: string;
	valueFrom?: V1EnvVarSource;
}
