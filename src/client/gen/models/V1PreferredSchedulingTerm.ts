import { V1NodeSelectorTerm } from "./V1NodeSelectorTerm";
export interface V1PreferredSchedulingTerm {
	preference: V1NodeSelectorTerm;
	weight: number;
}
