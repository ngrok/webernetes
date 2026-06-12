/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1RollingUpdateDeployment } from "./V1RollingUpdateDeployment";

export interface V1DeploymentStrategy {
	rollingUpdate?: V1RollingUpdateDeployment;
	type?: string;
}
