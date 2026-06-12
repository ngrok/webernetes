/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1AttachedVolume } from "./V1AttachedVolume";
import { V1ContainerImage } from "./V1ContainerImage";
import { V1NodeAddress } from "./V1NodeAddress";
import { V1NodeCondition } from "./V1NodeCondition";
import { V1NodeConfigStatus } from "./V1NodeConfigStatus";
import { V1NodeDaemonEndpoints } from "./V1NodeDaemonEndpoints";
import { V1NodeFeatures } from "./V1NodeFeatures";
import { V1NodeRuntimeHandler } from "./V1NodeRuntimeHandler";
import { V1NodeSystemInfo } from "./V1NodeSystemInfo";

export interface V1NodeStatus {
	addresses?: Array<V1NodeAddress>;
	allocatable?: { [key: string]: string };
	capacity?: { [key: string]: string };
	conditions?: Array<V1NodeCondition>;
	config?: V1NodeConfigStatus;
	daemonEndpoints?: V1NodeDaemonEndpoints;
	features?: V1NodeFeatures;
	images?: Array<V1ContainerImage>;
	nodeInfo?: V1NodeSystemInfo;
	phase?: string;
	runtimeHandlers?: Array<V1NodeRuntimeHandler>;
	volumesAttached?: Array<V1AttachedVolume>;
	volumesInUse?: Array<string>;
}
