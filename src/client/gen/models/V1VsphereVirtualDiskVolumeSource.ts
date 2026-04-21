export interface V1VsphereVirtualDiskVolumeSource {
	fsType?: string;
	storagePolicyID?: string;
	storagePolicyName?: string;
	volumePath: string;
}
