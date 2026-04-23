import { V1ContainerExtendedResourceRequest } from "./V1ContainerExtendedResourceRequest";
export interface V1PodExtendedResourceClaimStatus {
	requestMappings: Array<V1ContainerExtendedResourceRequest>;
	resourceClaimName: string;
}
