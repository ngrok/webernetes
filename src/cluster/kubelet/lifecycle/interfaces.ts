import type { V1Pod } from "../../../client";

// Models kubernetes/pkg/kubelet/lifecycle/interfaces.go PodSyncLoopHandler.
export interface PodSyncLoopHandler {
	shouldSync(pod: V1Pod): boolean;
}

// Models kubernetes/pkg/kubelet/lifecycle/interfaces.go PodSyncLoopHandlers.
export class PodSyncLoopHandlers {
	private readonly handlers: PodSyncLoopHandler[] = [];

	// Models kubernetes/pkg/kubelet/lifecycle/interfaces.go PodSyncLoopHandlers.AddPodSyncLoopHandler.
	addPodSyncLoopHandler(a: PodSyncLoopHandler): void {
		this.handlers.push(a);
	}

	[Symbol.iterator](): Iterator<PodSyncLoopHandler> {
		return this.handlers[Symbol.iterator]();
	}
}

// Models kubernetes/pkg/kubelet/lifecycle/interfaces.go ShouldEvictResponse.
export interface ShouldEvictResponse {
	evict: boolean;
	reason: string;
	message: string;
}

// Models kubernetes/pkg/kubelet/lifecycle/interfaces.go PodSyncHandler.
export interface PodSyncHandler {
	shouldEvict(pod: V1Pod): ShouldEvictResponse;
}

// Models kubernetes/pkg/kubelet/lifecycle/interfaces.go PodSyncHandlers.
export class PodSyncHandlers {
	private readonly handlers: PodSyncHandler[] = [];

	// Models kubernetes/pkg/kubelet/lifecycle/interfaces.go PodSyncHandlers.AddPodSyncHandler.
	addPodSyncHandler(a: PodSyncHandler): void {
		this.handlers.push(a);
	}

	[Symbol.iterator](): Iterator<PodSyncHandler> {
		return this.handlers[Symbol.iterator]();
	}
}
