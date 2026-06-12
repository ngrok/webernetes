/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1NodeSelector } from "./V1NodeSelector";
import { V1PreferredSchedulingTerm } from "./V1PreferredSchedulingTerm";
export interface V1NodeAffinity {
	preferredDuringSchedulingIgnoredDuringExecution?: Array<V1PreferredSchedulingTerm>;
	requiredDuringSchedulingIgnoredDuringExecution?: V1NodeSelector;
}
