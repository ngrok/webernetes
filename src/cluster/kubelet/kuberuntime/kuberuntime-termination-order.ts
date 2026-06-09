/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_termination_order.go terminationOrdering.
export interface TerminationOrdering {
	waitForTurn(name: string, gracePeriod: number): number | Promise<number>;
	containerTerminated(name: string): void;
}
