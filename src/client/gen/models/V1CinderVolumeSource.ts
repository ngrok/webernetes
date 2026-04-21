import { V1LocalObjectReference } from "./V1LocalObjectReference";
export interface V1CinderVolumeSource {
	fsType?: string;
	readOnly?: boolean;
	secretRef?: V1LocalObjectReference;
	volumeID: string;
}
