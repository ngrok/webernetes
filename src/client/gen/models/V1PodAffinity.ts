/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1PodAffinityTerm } from "./V1PodAffinityTerm";
import { V1WeightedPodAffinityTerm } from "./V1WeightedPodAffinityTerm";
export interface V1PodAffinity {
	preferredDuringSchedulingIgnoredDuringExecution?: Array<V1WeightedPodAffinityTerm>;
	requiredDuringSchedulingIgnoredDuringExecution?: Array<V1PodAffinityTerm>;
}
