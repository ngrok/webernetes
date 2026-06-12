/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1ContainerStateTerminated {
	containerID?: string;
	exitCode: number;
	finishedAt?: Date;
	message?: string;
	reason?: string;
	signal?: number;
	startedAt?: Date;
}
