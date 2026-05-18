import type { V1Pod } from "../../../../client";
import type { PodRuntimeStatus } from "../../../cri";
import { isHostNetworkPod } from "../../container";

interface PodSandboxChangedResult {
	changed: boolean;
	attempt: number;
	sandboxId: string;
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
