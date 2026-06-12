/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1TypedLocalObjectReference } from "./V1TypedLocalObjectReference";
export interface V1PodResourceClaim {
	name: string;
	resourceClaimName?: string;
	resourceClaimTemplateName?: string;
	source?: V1TypedLocalObjectReference;
}
