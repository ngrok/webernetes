/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1PodAffinityTerm } from "./V1PodAffinityTerm";
export interface V1WeightedPodAffinityTerm {
	podAffinityTerm: V1PodAffinityTerm;
	weight: number;
}
