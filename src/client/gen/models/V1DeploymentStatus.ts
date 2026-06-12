import { V1DeploymentCondition } from "./V1DeploymentCondition";

export interface V1DeploymentStatus {
	availableReplicas?: number;
	collisionCount?: number;
	conditions?: Array<V1DeploymentCondition>;
	observedGeneration?: number;
	readyReplicas?: number;
	replicas?: number;
	terminatingReplicas?: number;
	unavailableReplicas?: number;
	updatedReplicas?: number;
}
