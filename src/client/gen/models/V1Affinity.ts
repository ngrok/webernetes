import { V1NodeAffinity } from "./V1NodeAffinity";
import { V1PodAffinity } from "./V1PodAffinity";
import { V1PodAntiAffinity } from "./V1PodAntiAffinity";
export interface V1Affinity {
	nodeAffinity?: V1NodeAffinity;
	podAffinity?: V1PodAffinity;
	podAntiAffinity?: V1PodAntiAffinity;
}
