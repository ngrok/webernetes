export interface V1GlusterfsVolumeSource {
	endpoints: string;
	path: string;
	readOnly?: boolean;
}
