/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1ContainerExtendedResourceRequest } from "./V1ContainerExtendedResourceRequest";
export interface V1PodExtendedResourceClaimStatus {
	requestMappings: Array<V1ContainerExtendedResourceRequest>;
	resourceClaimName: string;
}
