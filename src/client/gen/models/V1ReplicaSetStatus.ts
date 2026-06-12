/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
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
