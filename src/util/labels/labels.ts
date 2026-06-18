/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1LabelSelector, V1LabelSelectorRequirement } from "../../client";

// Models kubernetes/pkg/util/labels/labels.go CloneSelectorAndAddLabel.
export function cloneSelectorAndAddLabel(
	selector: V1LabelSelector,
	labelKey: string,
	labelValue: string,
): V1LabelSelector {
	if (labelKey === "") {
		return selector;
	}

	const matchLabels: Record<string, string> = {};
	const newSelector: V1LabelSelector = { matchLabels };
	if (selector.matchLabels) {
		for (const [key, val] of Object.entries(selector.matchLabels)) {
			matchLabels[key] = val;
		}
	}
	matchLabels[labelKey] = labelValue;

	if (selector.matchExpressions) {
		const newMExps: V1LabelSelectorRequirement[] = [];
		for (const me of selector.matchExpressions) {
			const newME: V1LabelSelectorRequirement = {
				key: me.key,
				operator: me.operator,
			};
			if (me.values) {
				newME.values = [...me.values];
			}
			newMExps.push(newME);
		}
		newSelector.matchExpressions = newMExps;
	}

	return newSelector;
}
