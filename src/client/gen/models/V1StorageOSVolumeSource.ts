import { V1LocalObjectReference } from "./V1LocalObjectReference";
export interface V1StorageOSVolumeSource {
	fsType?: string;
	readOnly?: boolean;
	secretRef?: V1LocalObjectReference;
	volumeName?: string;
	volumeNamespace?: string;
}
