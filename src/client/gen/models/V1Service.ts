/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1ObjectMeta } from "./V1ObjectMeta";
import { V1ServiceSpec } from "./V1ServiceSpec";
import { V1ServiceStatus } from "./V1ServiceStatus";

export interface V1Service {
	apiVersion?: string;
	kind?: string;
	metadata?: V1ObjectMeta;
	spec?: V1ServiceSpec;
	status?: V1ServiceStatus;
}
