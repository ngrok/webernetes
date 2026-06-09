/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type * as context from "../../../go/context";
import { parseIP as parseIPSloppy } from "../../../go/net";
import type { PodSandboxStatus } from "../../cri";

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_sandbox.go kubeGenericRuntimeManager.determinePodSandboxIPs.
export function determinePodSandboxIPs(
	_ctx: context.Context,
	_podNamespace: string,
	_podName: string,
	podSandbox: PodSandboxStatus,
): string[] {
	const podIPs: string[] = [];
	if (!podSandbox.network) {
		return podIPs;
	}

	if (podSandbox.network.ip.length !== 0) {
		if (!parseIPSloppy(podSandbox.network.ip)) {
			return [];
		}
		podIPs.push(podSandbox.network.ip);
	}

	for (const podIP of podSandbox.network.additionalIps ?? []) {
		if (!parseIPSloppy(podIP.ip)) {
			return [];
		}
		podIPs.push(podIP.ip);
	}
	return podIPs;
}
