/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1DaemonEndpoint } from "./V1DaemonEndpoint";

export interface V1NodeDaemonEndpoints {
	kubeletEndpoint?: V1DaemonEndpoint;
}
