/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1PodDNSConfigOption } from "./V1PodDNSConfigOption";
export interface V1PodDNSConfig {
	nameservers?: Array<string>;
	options?: Array<V1PodDNSConfigOption>;
	searches?: Array<string>;
}
