import { V1LabelSelector } from "./V1LabelSelector";
export interface V1PodAffinityTerm {
	matchLabelKeys?: Array<string>;
	labelSelector?: V1LabelSelector;
	mismatchLabelKeys?: Array<string>;
	namespaceSelector?: V1LabelSelector;
	namespaces?: Array<string>;
	topologyKey: string;
}
