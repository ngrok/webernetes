import type { V1Pod } from "../../../../client";
import type { PodRuntimeStatus } from "../../../cri";
import { isHostNetworkPod } from "../../container";

// Models kubernetes/pkg/kubelet/util/util.go GetNodenameForKernel.
export function getNodenameForKernel(
	hostname: string,
	hostDomainName: string,
	setHostnameAsFQDN: boolean | undefined,
): [nodeName: string, err: Error | undefined] {
	let kernelHostname = hostname;
	const fqdnMaxLen = 64;
	if (hostDomainName.length > 0 && setHostnameAsFQDN === true) {
		const fqdn = `${hostname}.${hostDomainName}`;
		if (fqdn.length > fqdnMaxLen) {
			return [
				"",
				new Error(
					`failed to construct FQDN from pod hostname and cluster domain, FQDN ${fqdn} is too long (${fqdnMaxLen} characters is the max, ${fqdn.length} characters requested)`,
				),
			];
		}
		kernelHostname = fqdn;
	}
	return [kernelHostname, undefined];
}

// Models kubernetes/pkg/kubelet/kuberuntime/util/util.go PodSandboxChanged.
export function podSandboxChanged(
	pod: V1Pod,
	podStatus: PodRuntimeStatus,
): [changed: boolean, attempt: number, sandboxId: string] {
	if (podStatus.sandboxStatuses.length === 0) {
		return [true, 0, ""];
	}

	let readySandboxCount = 0;
	for (const sandbox of podStatus.sandboxStatuses) {
		if (sandbox.state === "Ready") {
			readySandboxCount++;
		}
	}

	const sandboxStatus = podStatus.sandboxStatuses[0];
	if (!sandboxStatus) {
		return [true, 0, ""];
	}
	if (readySandboxCount > 1) {
		return [true, sandboxStatus.metadata.attempt + 1, sandboxStatus.id];
	}
	if (sandboxStatus.state !== "Ready") {
		return [true, sandboxStatus.metadata.attempt + 1, sandboxStatus.id];
	}

	if (
		!isHostNetworkPod(pod) &&
		sandboxStatus.network !== undefined &&
		sandboxStatus.network.ip === ""
	) {
		return [true, sandboxStatus.metadata.attempt + 1, sandboxStatus.id];
	}

	return [false, sandboxStatus.metadata.attempt, sandboxStatus.id];
}
