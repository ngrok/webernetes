export interface V1QuobyteVolumeSource {
	group?: string;
	readOnly?: boolean;
	registry: string;
	tenant?: string;
	user?: string;
	volume: string;
}
