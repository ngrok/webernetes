/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1VolumeMount {
	mountPath: string;
	mountPropagation?: string;
	name: string;
	readOnly?: boolean;
	recursiveReadOnly?: string;
	subPath?: string;
	subPathExpr?: string;
}
