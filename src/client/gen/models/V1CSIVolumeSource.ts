import { V1LocalObjectReference } from "./V1LocalObjectReference";
export interface V1CSIVolumeSource {
	driver: string;
	fsType?: string;
	nodePublishSecretRef?: V1LocalObjectReference;
	readOnly?: boolean;
	volumeAttributes?: {
		[key: string]: string;
	};
}
