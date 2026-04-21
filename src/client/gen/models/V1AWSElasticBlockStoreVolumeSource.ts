export interface V1AWSElasticBlockStoreVolumeSource {
	fsType?: string;
	partition?: number;
	readOnly?: boolean;
	volumeID: string;
}
