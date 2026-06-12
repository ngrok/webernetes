/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1ContainerPort {
	containerPort: number;
	hostIP?: string;
	hostPort?: number;
	name?: string;
	protocol?: string;
}
