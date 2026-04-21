export interface V1NFSVolumeSource {
	path: string;
	readOnly?: boolean;
	server: string;
}
