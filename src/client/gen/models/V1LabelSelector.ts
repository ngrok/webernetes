import { V1LabelSelectorRequirement } from "./V1LabelSelectorRequirement";
export interface V1LabelSelector {
	matchExpressions?: Array<V1LabelSelectorRequirement>;
	matchLabels?: {
		[key: string]: string;
	};
}
