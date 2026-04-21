import { V1LocalObjectReference } from "./V1LocalObjectReference";
export interface V1FlexVolumeSource {
	driver: string;
	fsType?: string;
	options?: {
		[key: string]: string;
	};
	readOnly?: boolean;
	secretRef?: V1LocalObjectReference;
}
