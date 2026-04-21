import { V1LabelSelector } from "./V1LabelSelector";
export interface V1ClusterTrustBundleProjection {
	labelSelector?: V1LabelSelector;
	name?: string;
	optional?: boolean;
	path: string;
	signerName?: string;
}
