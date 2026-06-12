/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1SELinuxOptions {
	level?: string;
	role?: string;
	type?: string;
	user?: string;
}
