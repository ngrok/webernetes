import { V1PodAffinityTerm } from "./V1PodAffinityTerm";
export interface V1WeightedPodAffinityTerm {
	podAffinityTerm: V1PodAffinityTerm;
	weight: number;
}
