export interface V1PersistentVolumeClaimVolumeSource {
	claimName: string;
	readOnly?: boolean;
}
