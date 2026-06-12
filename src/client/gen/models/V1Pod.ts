/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1ObjectMeta } from "./V1ObjectMeta";
import { V1PodSpec } from "./V1PodSpec";
import { V1PodStatus } from "./V1PodStatus";
export interface V1Pod {
	apiVersion?: string;
	kind?: string;
	metadata?: V1ObjectMeta;
	spec?: V1PodSpec;
	status?: V1PodStatus;
}
