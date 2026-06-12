/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1ContainerRestartRuleOnExitCodes {
	containerName?: string;
	operator: string;
	values?: Array<number>;
}
