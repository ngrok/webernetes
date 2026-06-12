/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1NodeCondition {
	lastHeartbeatTime?: Date;
	lastTransitionTime?: Date;
	message?: string;
	reason?: string;
	status: string;
	type: string;
}
