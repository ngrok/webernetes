import { V1LocalObjectReference } from "./V1LocalObjectReference";
export interface V1ImageVolumeSource {
	pullPolicy?: string;
	reference?: string;
	secretRef?: V1LocalObjectReference;
}
