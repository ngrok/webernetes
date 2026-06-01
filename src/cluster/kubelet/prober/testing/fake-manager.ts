import type { V1Pod, V1PodStatus } from "../../../../client";
import type { Context } from "../../../../go/context";
import type { ProbeManager } from "../prober-manager";

// Models kubernetes/pkg/kubelet/prober/testing/fake_manager.go FakeManager.
export class FakeManager implements ProbeManager {
	// Models kubernetes/pkg/kubelet/prober/testing/fake_manager.go AddPod.
	addPod(_ctx: Context, _pod: V1Pod): void {}

	// Models kubernetes/pkg/kubelet/prober/testing/fake_manager.go RemovePod.
	removePod(_pod: V1Pod): void {}

	// Models kubernetes/pkg/kubelet/prober/testing/fake_manager.go StopLivenessAndStartup.
	stopLivenessAndStartup(_pod: V1Pod): void {}

	// Models kubernetes/pkg/kubelet/prober/testing/fake_manager.go CleanupPods.
	cleanupPods(_desiredPods: Set<string>): void {}

	// Models kubernetes/pkg/kubelet/prober/testing/fake_manager.go Start.
	start(): void {}

	// Models kubernetes/pkg/kubelet/prober/testing/fake_manager.go UpdatePodStatus.
	updatePodStatus(_ctx: Context, _pod: V1Pod, podStatus: V1PodStatus): void {
		for (const containerStatus of podStatus.containerStatuses ?? []) {
			containerStatus.ready = true;
		}
	}
}
