/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1ContainerRestartRuleOnExitCodes } from "./V1ContainerRestartRuleOnExitCodes";
export interface V1ContainerRestartRule {
	action: string;
	exitCodes?: V1ContainerRestartRuleOnExitCodes;
}
