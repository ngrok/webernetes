/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1NodeRuntimeHandlerFeatures } from "./V1NodeRuntimeHandlerFeatures";

export interface V1NodeRuntimeHandler {
	features?: V1NodeRuntimeHandlerFeatures;
	name?: string;
}
