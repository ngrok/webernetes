import { EventEmitter } from "events";
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
export class ResultsManager extends EventEmitter {
	private readonly cache = new Map<string, ProberResult>();

	// Models kubernetes/pkg/kubelet/prober/results/results_manager.go Get.
	get(containerId: ContainerID): ProberResult | undefined {
		return this.cache.get(containerId.toString());
	}

	// Models kubernetes/pkg/kubelet/prober/results/results_manager.go Set.
	set(containerId: ContainerID, result: ProberResult, pod: V1Pod): void {
		const key = containerId.toString();
		if (this.cache.get(key) === result) {
			return;
		}
		this.cache.set(key, result);
		this.emit("update", {
			containerId,
			result,
			podUid: pod.metadata?.uid ?? "",
		});
	}

	// Models kubernetes/pkg/kubelet/prober/results/results_manager.go Remove.
	remove(containerId: ContainerID): void {
		this.cache.delete(containerId.toString());
	}

	// Simulator lifecycle cleanup; Kubernetes' results manager has no Close method.
	close(): void {
		this.removeAllListeners();
	}
}
