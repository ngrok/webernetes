import { V1LocalObjectReference } from "./V1LocalObjectReference";
export interface V1CephFSVolumeSource {
	monitors: Array<string>;
	path?: string;
	readOnly?: boolean;
	secretFile?: string;
	secretRef?: V1LocalObjectReference;
	user?: string;
}
