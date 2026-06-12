import { V1ObjectMeta } from "./V1ObjectMeta";
import { V1ReplicaSetSpec } from "./V1ReplicaSetSpec";
import { V1ReplicaSetStatus } from "./V1ReplicaSetStatus";

export interface V1ReplicaSet {
	apiVersion?: string;
	kind?: string;
	metadata?: V1ObjectMeta;
	spec?: V1ReplicaSetSpec;
	status?: V1ReplicaSetStatus;
}
