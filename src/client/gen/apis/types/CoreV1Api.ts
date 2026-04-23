import { V1Pod } from "../../models";

export interface CoreV1ApiCreateNamespacedPodRequest {
	namespace: string;
	body: V1Pod;
	pretty?: string;
	dryRun?: string;
	fieldManager?: string;
	fieldValidation?: string;
}

export interface CoreV1Api {
	createNamespacedPod(request: CoreV1ApiCreateNamespacedPodRequest): Promise<V1Pod>;
}
