import { V1LabelSelector } from "./V1LabelSelector";
import { V1PodTemplateSpec } from "./V1PodTemplateSpec";

export interface V1ReplicaSetSpec {
	minReadySeconds?: number;
	replicas?: number;
	selector: V1LabelSelector;
	template?: V1PodTemplateSpec;
}
