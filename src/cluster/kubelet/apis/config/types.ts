/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// Models kubernetes/pkg/kubelet/apis/config/types.go KubeletConfiguration.
export interface KubeletConfiguration {
	syncFrequencyMs: number;
	clusterDNS: string[];
	clusterDomain: string;
	registryPullQPS: number;
	registryBurst: number;
	serializeImagePulls: boolean;
	maxParallelImagePulls: number | undefined;
	minimumGCAgeMs: number;
	maxPerPodContainerCount: number;
	maxContainerCount: number;
	nodeStatusMaxImages: number;
}
