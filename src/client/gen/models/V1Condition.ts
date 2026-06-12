/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1Condition {
	lastTransitionTime: Date;
	message: string;
	observedGeneration?: number;
	reason: string;
	status: string;
	type: string;
}
