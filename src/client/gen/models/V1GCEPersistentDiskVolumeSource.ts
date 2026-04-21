export interface V1GCEPersistentDiskVolumeSource {
	fsType?: string;
	partition?: number;
	pdName: string;
	readOnly?: boolean;
}
