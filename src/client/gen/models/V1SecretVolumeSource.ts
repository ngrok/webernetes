import { V1KeyToPath } from "./V1KeyToPath";
export interface V1SecretVolumeSource {
	defaultMode?: number;
	items?: Array<V1KeyToPath>;
	optional?: boolean;
	secretName?: string;
}
