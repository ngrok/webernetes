import type { V1Container } from "../../../client";

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container.go startSpec.
export interface StartSpec {
	container: V1Container;
}
