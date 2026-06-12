/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1NodeSpec } from "./V1NodeSpec";
import { V1NodeStatus } from "./V1NodeStatus";
import { V1ObjectMeta } from "./V1ObjectMeta";

export interface V1Node {
	apiVersion?: string;
	kind?: string;
	metadata?: V1ObjectMeta;
	spec?: V1NodeSpec;
	status?: V1NodeStatus;
}
