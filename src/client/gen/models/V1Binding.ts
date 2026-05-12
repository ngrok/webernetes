import { V1ObjectMeta } from "./V1ObjectMeta";
import { V1ObjectReference } from "./V1ObjectReference";

export interface V1Binding {
	apiVersion?: string;
	kind?: string;
	metadata?: V1ObjectMeta;
	target: V1ObjectReference;
}
