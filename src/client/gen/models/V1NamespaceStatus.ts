/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1NamespaceCondition } from "./V1NamespaceCondition";

export interface V1NamespaceStatus {
	conditions?: Array<V1NamespaceCondition>;
	phase?: string;
}
