/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type * as k8s from "../../client";
import { getActualReplicaCountForReplicaSets } from "./util/deployment-util";

// Models kubernetes/pkg/controller/deployment/recreate.go oldPodsRunning.
export function oldPodsRunning(
	newRS: k8s.V1ReplicaSet | undefined,
	oldRSs: k8s.V1ReplicaSet[],
	podMap: Map<string, k8s.V1Pod[]>,
): boolean {
	if (getActualReplicaCountForReplicaSets(oldRSs) > 0) {
		return true;
	}
	for (const [rsUID, podList] of podMap) {
		if (newRS?.metadata?.uid === rsUID) {
			continue;
		}
		for (const pod of podList) {
			switch (pod.status?.phase) {
				case "Failed":
				case "Succeeded":
					continue;
				case "Unknown":
					return true;
				default:
					return true;
			}
		}
	}
	return false;
}
