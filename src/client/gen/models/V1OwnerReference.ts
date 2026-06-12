/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1OwnerReference {
	apiVersion: string;
	blockOwnerDeletion?: boolean;
	controller?: boolean;
	kind: string;
	name: string;
	uid: string;
}
