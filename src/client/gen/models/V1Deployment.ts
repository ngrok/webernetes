import { V1DeploymentSpec } from "./V1DeploymentSpec";
import { V1DeploymentStatus } from "./V1DeploymentStatus";
import { V1ObjectMeta } from "./V1ObjectMeta";

export interface V1Deployment {
	apiVersion?: string;
	kind?: string;
	metadata?: V1ObjectMeta;
	spec?: V1DeploymentSpec;
	status?: V1DeploymentStatus;
}
