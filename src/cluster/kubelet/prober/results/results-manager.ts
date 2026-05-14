import { Channel, type ReadOnlyChannel } from "../../../../channel";
import type { V1Pod } from "../../../../client";
import type { ContainerID } from "../../container";

export type ProbeType = "liveness" | "readiness" | "startup";

// Models kubernetes/pkg/kubelet/prober/results/results_manager.go Result.
export type ProberResult = "success" | "failure" | "unknown";

export interface ProbeKey {
	podUid: string;
	containerName: string;
	probeType: ProbeType;
}

export interface ProbeUpdate {
	containerId: ContainerID;
	result: ProberResult;
	podUid: string;
}

// Models kubernetes/pkg/kubelet/prober/results/results_manager.go manager.
export class ResultsManager {
	private readonly cache = new Map<string, ProberResult>();
	private readonly updatesCh = new Channel<ProbeUpdate>(20);
	private closed = false;

	// Models kubernetes/pkg/kubelet/prober/results/results_manager.go Get.
	get(containerId: ContainerID): ProberResult | undefined {
		return this.cache.get(containerId.toString());
	}

	// Models kubernetes/pkg/kubelet/prober/results/results_manager.go Set.
	async set(containerId: ContainerID, result: ProberResult, pod: V1Pod): Promise<void> {
		if (this.setInternal(containerId, result)) {
			await this.updatesCh.send({
				containerId,
				result,
				podUid: pod.metadata?.uid ?? "",
			});
		}
	}

	// Models kubernetes/pkg/kubelet/prober/results/results_manager.go setInternal.
	private setInternal(containerId: ContainerID, result: ProberResult): boolean {
		if (this.closed) {
			return false;
		}
		const key = containerId.toString();
		if (this.cache.get(key) === result) {
			return false;
		}
		this.cache.set(key, result);
		return true;
	}

	// Models kubernetes/pkg/kubelet/prober/results/results_manager.go Remove.
	remove(containerId: ContainerID): void {
		this.cache.delete(containerId.toString());
	}

	// Models kubernetes/pkg/kubelet/prober/results/results_manager.go Updates.
	updates(): ReadOnlyChannel<ProbeUpdate> {
		return this.updatesCh.readOnly();
	}

	// Simulator lifecycle cleanup; Kubernetes' results manager has no Close method.
	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.updatesCh.close();
	}
}
