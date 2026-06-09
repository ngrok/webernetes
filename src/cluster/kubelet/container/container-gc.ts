/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type * as context from "../../../go/context";
import type { Runtime } from "./runtime";

// Models kubernetes/pkg/kubelet/container/container_gc.go GCPolicy.
export interface GCPolicy {
	minAgeMs?: number;
	maxPerPodContainer?: number;
	maxContainers?: number;
}

// Models kubernetes/pkg/kubelet/container/container_gc.go GC.
export interface GC {
	garbageCollect(ctx: context.Context): Promise<Error | undefined>;
	deleteAllUnusedContainers(ctx: context.Context): Promise<Error | undefined>;
}

// Models kubernetes/pkg/kubelet/container/container_gc.go SourcesReadyProvider.
export interface SourcesReadyProvider {
	allReady(): boolean;
}

// Models kubernetes/pkg/kubelet/container/container_gc.go realContainerGC.
class RealContainerGC implements GC {
	constructor(
		private readonly runtime: Runtime,
		private readonly policy: GCPolicy,
		private readonly sourcesReadyProvider: SourcesReadyProvider,
	) {}

	// Models kubernetes/pkg/kubelet/container/container_gc.go realContainerGC.GarbageCollect.
	async garbageCollect(ctx: context.Context): Promise<Error | undefined> {
		return await this.runtime.garbageCollect(
			ctx,
			this.policy,
			this.sourcesReadyProvider.allReady(),
			false,
		);
	}

	// Models kubernetes/pkg/kubelet/container/container_gc.go realContainerGC.DeleteAllUnusedContainers.
	async deleteAllUnusedContainers(ctx: context.Context): Promise<Error | undefined> {
		return await this.runtime.garbageCollect(
			ctx,
			this.policy,
			this.sourcesReadyProvider.allReady(),
			true,
		);
	}
}

// Models kubernetes/pkg/kubelet/container/container_gc.go NewContainerGC.
export function newContainerGC(
	runtime: Runtime,
	policy: GCPolicy,
	sourcesReadyProvider: SourcesReadyProvider,
): [gc: GC | undefined, err: Error | undefined] {
	if ((policy.minAgeMs ?? 0) < 0) {
		return [undefined, new Error(`invalid minimum garbage collection age: ${policy.minAgeMs}`)];
	}
	return [new RealContainerGC(runtime, policy, sourcesReadyProvider), undefined];
}
