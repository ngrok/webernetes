export interface V1AzureDiskVolumeSource {
	cachingMode?: string;
	diskName: string;
	diskURI: string;
	fsType?: string;
	kind?: string;
	readOnly?: boolean;
}
