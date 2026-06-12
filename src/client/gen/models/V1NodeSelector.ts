/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1NodeSelectorTerm } from "./V1NodeSelectorTerm";
export interface V1NodeSelector {
	nodeSelectorTerms: Array<V1NodeSelectorTerm>;
}
