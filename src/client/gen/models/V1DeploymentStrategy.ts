import { V1RollingUpdateDeployment } from "./V1RollingUpdateDeployment";

export interface V1DeploymentStrategy {
	rollingUpdate?: V1RollingUpdateDeployment;
	type?: string;
}
