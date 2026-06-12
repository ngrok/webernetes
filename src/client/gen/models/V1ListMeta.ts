/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
export interface V1ListMeta {
	_continue?: string;
	remainingItemCount?: number;
	resourceVersion?: string;
	selfLink?: string;
}
