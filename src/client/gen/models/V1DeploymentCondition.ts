/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1DeploymentCondition {
	lastTransitionTime?: Date;
	lastUpdateTime?: Date;
	message?: string;
	reason?: string;
	status: string;
	type: string;
}
