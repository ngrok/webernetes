/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1PodCondition {
	lastProbeTime?: Date;
	lastTransitionTime?: Date;
	message?: string;
	observedGeneration?: number;
	reason?: string;
	status: string;
	type: string;
}
