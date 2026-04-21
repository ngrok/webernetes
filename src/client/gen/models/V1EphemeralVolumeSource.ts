import { V1PersistentVolumeClaimTemplate } from "./V1PersistentVolumeClaimTemplate";
export interface V1EphemeralVolumeSource {
	volumeClaimTemplate?: V1PersistentVolumeClaimTemplate;
}
