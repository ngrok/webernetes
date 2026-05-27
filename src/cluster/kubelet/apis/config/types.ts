// Models kubernetes/pkg/kubelet/apis/config/types.go KubeletConfiguration.
export interface KubeletConfiguration {
	syncFrequencyMs: number;
	clusterDNS: string[];
	clusterDomain: string;
	serializeImagePulls: boolean;
	maxParallelImagePulls: number | undefined;
}
