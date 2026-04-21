import { V1LocalObjectReference } from "./V1LocalObjectReference";
export interface V1ISCSIVolumeSource {
	chapAuthDiscovery?: boolean;
	chapAuthSession?: boolean;
	fsType?: string;
	initiatorName?: string;
	iqn: string;
	iscsiInterface?: string;
	lun: number;
	portals?: Array<string>;
	readOnly?: boolean;
	secretRef?: V1LocalObjectReference;
	targetPortal: string;
}
