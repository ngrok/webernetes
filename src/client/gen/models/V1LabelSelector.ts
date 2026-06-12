/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1LabelSelectorRequirement } from "./V1LabelSelectorRequirement";
export interface V1LabelSelector {
	matchExpressions?: Array<V1LabelSelectorRequirement>;
	matchLabels?: {
		[key: string]: string;
	};
}
