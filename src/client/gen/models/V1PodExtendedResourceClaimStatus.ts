import { V1ContainerExtendedResourceRequest } from "./V1ContainerExtendedResourceRequest";
export interface V1PodExtendedResourceClaimStatus {
	name: string;
	requests?: Array<V1ContainerExtendedResourceRequest>;
}
