/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1ConfigMapNodeConfigSource } from "./V1ConfigMapNodeConfigSource";

export interface V1NodeConfigSource {
	configMap?: V1ConfigMapNodeConfigSource;
}
