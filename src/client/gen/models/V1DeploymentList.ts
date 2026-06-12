import { V1Deployment } from "./V1Deployment";
import { V1ListMeta } from "./V1ListMeta";

export interface V1DeploymentList {
	apiVersion?: string;
	kind?: string;
	metadata?: V1ListMeta;
	items: Array<V1Deployment>;
}
