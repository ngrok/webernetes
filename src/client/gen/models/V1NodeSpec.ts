export interface V1NodeSpec {
	externalID?: string;
	podCIDR?: string;
	podCIDRs?: Array<string>;
	providerID?: string;
	unschedulable?: boolean;
}
