// Models kubernetes/pkg/kubelet/apis/config/types.go KubeletConfiguration.
export interface KubeletConfiguration {
	syncFrequencyMs: number;
	clusterDNS: string[];
	clusterDomain: string;
	registryPullQPS: number;
	registryBurst: number;
	serializeImagePulls: boolean;
	maxParallelImagePulls: number | undefined;
}
