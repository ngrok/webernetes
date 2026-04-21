import { V1LabelSelector } from "./V1LabelSelector";
export interface V1TopologySpreadConstraint {
	labelSelector?: V1LabelSelector;
	matchLabelKeys?: Array<string>;
	maxSkew: number;
	minDomains?: number;
	nodeAffinityPolicy?: string;
	nodeTaintsPolicy?: string;
	topologyKey: string;
	whenUnsatisfiable: string;
}
