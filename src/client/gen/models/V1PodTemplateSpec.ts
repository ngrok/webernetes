import { V1ObjectMeta } from "./V1ObjectMeta";
import { V1PodSpec } from "./V1PodSpec";

export interface V1PodTemplateSpec {
	metadata?: V1ObjectMeta;
	spec?: V1PodSpec;
}
