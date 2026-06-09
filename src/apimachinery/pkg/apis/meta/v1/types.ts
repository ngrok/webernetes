/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// Models staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/types.go ListOptions.
export interface ListOptions {
	labelSelector?: string;
	fieldSelector?: string;
	watch?: boolean;
	resourceVersion?: string;
	resourceVersionMatch?: string;
	limit?: number;
	timeoutSeconds?: number;
	allowWatchBookmarks?: boolean;
	sendInitialEvents?: boolean;
}
