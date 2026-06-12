/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1LinuxContainerUser {
	gid: number;
	supplementalGroups?: Array<number>;
	uid: number;
}
