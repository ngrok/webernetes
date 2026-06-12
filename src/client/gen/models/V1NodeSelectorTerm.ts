/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1NodeSelectorRequirement } from "./V1NodeSelectorRequirement";
export interface V1NodeSelectorTerm {
	matchExpressions?: Array<V1NodeSelectorRequirement>;
	matchFields?: Array<V1NodeSelectorRequirement>;
}
