import type { IntOrString } from "../../types";

export interface V1RollingUpdateDeployment {
	maxSurge?: IntOrString;
	maxUnavailable?: IntOrString;
}
