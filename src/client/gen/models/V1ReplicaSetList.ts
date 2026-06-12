/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1ListMeta } from "./V1ListMeta";
import { V1ReplicaSet } from "./V1ReplicaSet";

export interface V1ReplicaSetList {
	apiVersion?: string;
	kind?: string;
	metadata?: V1ListMeta;
	items: Array<V1ReplicaSet>;
}
