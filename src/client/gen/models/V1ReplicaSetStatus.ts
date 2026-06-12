import { V1ReplicaSetCondition } from "./V1ReplicaSetCondition";

export interface V1ReplicaSetStatus {
	availableReplicas?: number;
	conditions?: Array<V1ReplicaSetCondition>;
	fullyLabeledReplicas?: number;
	observedGeneration?: number;
	readyReplicas?: number;
	replicas: number;
	terminatingReplicas?: number;
}
