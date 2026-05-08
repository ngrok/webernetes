import { EventEmitter } from "events";
import type { V1Pod } from "../../client";

export type ProbeType = "liveness" | "readiness" | "startup";
export type ProbeResult = "success" | "failure" | "unknown";

export interface ProbeKey {
	podUid: string;
	containerName: string;
	probeType: ProbeType;
}

export interface ProbeUpdate {
	containerId: string;
	result: ProbeResult;
	podUid: string;
}

export class ResultsManager extends EventEmitter {
	private readonly cache = new Map<string, ProbeResult>();

	get(containerId: string): ProbeResult | undefined {
		return this.cache.get(containerId);
	}

	set(containerId: string, result: ProbeResult, pod: V1Pod): void {
		if (this.cache.get(containerId) === result) {
			return;
		}
		this.cache.set(containerId, result);
		this.emit("update", {
			containerId,
			result,
			podUid: pod.metadata?.uid ?? "",
		});
	}

	remove(containerId: string): void {
		this.cache.delete(containerId);
	}

	close(): void {
		this.removeAllListeners();
	}
}
