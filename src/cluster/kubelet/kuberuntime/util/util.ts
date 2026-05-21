import type { V1Pod } from "../../../../client";
import type { PodRuntimeStatus } from "../../../cri";
import { isHostNetworkPod } from "../../container";

interface PodSandboxChangedResult {
	changed: boolean;
	attempt: number;
	sandboxId: string;
}

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
): PodSandboxChangedResult {
	if (podStatus.sandboxStatuses.length === 0) {
		return { changed: true, attempt: 0, sandboxId: "" };
	}

	let readySandboxCount = 0;
	for (const sandbox of podStatus.sandboxStatuses) {
		if (sandbox.state === "Ready") {
			readySandboxCount++;
		}
	}

	const sandboxStatus = podStatus.sandboxStatuses[0];
	if (!sandboxStatus) {
		return { changed: true, attempt: 0, sandboxId: "" };
	}
	if (readySandboxCount > 1) {
		return {
			changed: true,
			attempt: sandboxStatus.metadata.attempt + 1,
			sandboxId: sandboxStatus.id,
		};
	}
	if (sandboxStatus.state !== "Ready") {
		return {
			changed: true,
			attempt: sandboxStatus.metadata.attempt + 1,
			sandboxId: sandboxStatus.id,
		};
	}

	if (
		!isHostNetworkPod(pod) &&
		sandboxStatus.network !== undefined &&
		sandboxStatus.network.ip === ""
	) {
		return {
			changed: true,
			attempt: sandboxStatus.metadata.attempt + 1,
			sandboxId: sandboxStatus.id,
		};
	}

	return {
		changed: false,
		attempt: sandboxStatus.metadata.attempt,
		sandboxId: sandboxStatus.id,
	};
}
