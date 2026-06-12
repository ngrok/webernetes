/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1ContainerStatus } from "./V1ContainerStatus";
import { V1HostIP } from "./V1HostIP";
import { V1NodeAllocatableResourceClaimStatus } from "./V1NodeAllocatableResourceClaimStatus";
import { V1PodCondition } from "./V1PodCondition";
import { V1PodExtendedResourceClaimStatus } from "./V1PodExtendedResourceClaimStatus";
import { V1PodIP } from "./V1PodIP";
import { V1PodResourceClaimStatus } from "./V1PodResourceClaimStatus";
export interface V1PodStatus {
	conditions?: Array<V1PodCondition>;
	containerStatuses?: Array<V1ContainerStatus>;
	ephemeralContainerStatuses?: Array<V1ContainerStatus>;
	extendedResourceClaimStatus?: V1PodExtendedResourceClaimStatus;
	hostIP?: string;
	hostIPs?: Array<V1HostIP>;
	initContainerStatuses?: Array<V1ContainerStatus>;
	message?: string;
	nominatedNodeName?: string;
	nodeAllocatableResourceClaimStatuses?: Array<V1NodeAllocatableResourceClaimStatus>;
	observedGeneration?: number;
	phase?: string;
	podIP?: string;
	podIPs?: Array<V1PodIP>;
	qosClass?: string;
	reason?: string;
	resize?: string;
	resourceClaimStatuses?: Array<V1PodResourceClaimStatus>;
	startTime?: Date;
}
