export interface V1AzureFileVolumeSource {
	readOnly?: boolean;
	secretName: string;
	shareName: string;
}
