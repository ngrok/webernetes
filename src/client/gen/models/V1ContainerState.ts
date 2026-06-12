/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1ContainerStateRunning } from "./V1ContainerStateRunning";
import { V1ContainerStateTerminated } from "./V1ContainerStateTerminated";
import { V1ContainerStateWaiting } from "./V1ContainerStateWaiting";
export interface V1ContainerState {
	running?: V1ContainerStateRunning;
	terminated?: V1ContainerStateTerminated;
	waiting?: V1ContainerStateWaiting;
}
