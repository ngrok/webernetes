/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { newAggregate } from "../../../apimachinery/pkg/util/errors/errors";
import { getClock } from "../../../clock-context";
import type * as context from "../../../go/context";
import type { RuntimeService } from "../../cri";
import { buildContainerID, type GCPolicy } from "../container";
import { getContainerInfoFromLabels } from "./labels";
import type { KubeGenericRuntimeManager, PodStateProvider } from "./kuberuntime-manager";

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go containerGC.
export class ContainerGC {
	constructor(
		private readonly client: RuntimeService,
		readonly podStateProvider: PodStateProvider,
		private readonly manager: KubeGenericRuntimeManager,
	) {}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go containerGC.enforceMaxContainersPerEvictUnit.
	async enforceMaxContainersPerEvictUnit(
		ctx: context.Context,
		evictUnits: ContainersByEvictUnit,
		maxContainers: number,
	): Promise<void> {
		for (const key of evictUnits.keys()) {
			const unit = evictUnits.get(key) ?? [];
			const toRemove = unit.length - maxContainers;
			if (toRemove > 0) {
				evictUnits.set(key, await this.removeOldestN(ctx, unit, toRemove));
			}
		}
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go containerGC.removeOldestN.
	async removeOldestN(
		ctx: context.Context,
		containers: ContainerGCInfo[],
		toRemove: number,
	): Promise<ContainerGCInfo[]> {
		const numToKeep = containers.length - toRemove;
		if (numToKeep > 0) {
			containers.sort(byCreated);
		}
		for (let i = containers.length - 1; i >= numToKeep; i--) {
			const container = containers[i];
			if (!container) {
				continue;
			}
			if (container.unknown) {
				const id = buildContainerID(this.manager.type(), container.id);
				const message = "Container is in unknown state, try killing it before removal";
				const err = await this.manager.killContainer(
					ctx,
					undefined,
					id,
					container.name,
					message,
					"Unknown",
					undefined,
					undefined,
				);
				if (err) {
					continue;
				}
			}
			await this.manager.removeContainer(ctx, container.id, false);
		}
		return containers.slice(0, numToKeep);
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go containerGC.removeOldestNSandboxes.
	async removeOldestNSandboxes(
		ctx: context.Context,
		sandboxes: SandboxGCInfo[],
		toRemove: number,
	): Promise<void> {
		const numToKeep = sandboxes.length - toRemove;
		if (numToKeep > 0) {
			sandboxes.sort(sandboxByCreated);
		}
		for (let i = sandboxes.length - 1; i >= numToKeep; i--) {
			const sandbox = sandboxes[i];
			if (sandbox && !sandbox.active) {
				await this.removeSandbox(ctx, sandbox.id);
			}
		}
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go containerGC.removeSandbox.
	async removeSandbox(ctx: context.Context, sandboxID: string): Promise<void> {
		const stopErr = await this.client.stopPodSandbox(ctx, sandboxID);
		if (stopErr) {
			return;
		}
		await this.client.removePodSandbox(ctx, sandboxID);
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go containerGC.evictableContainers.
	async evictableContainers(
		ctx: context.Context,
		minAgeMs: number,
	): Promise<[containers: ContainersByEvictUnit, err: Error | undefined]> {
		const [containers, err] = await this.manager.getContainers(ctx, {});
		if (err) {
			return [new ContainersByEvictUnit(), err];
		}

		const evictUnits = new ContainersByEvictUnit();
		const newestGCTime = getClock(ctx).nowMs() - minAgeMs;
		for (const container of containers) {
			if (container.state === "Running") {
				continue;
			}
			if (container.createdAt > newestGCTime) {
				continue;
			}
			const labeledInfo = getContainerInfoFromLabels(container.labels);
			const containerInfo: ContainerGCInfo = {
				id: container.id,
				name: container.metadata.name,
				createTime: container.createdAt,
				unknown: container.state === "Unknown",
			};
			const key: EvictUnit = {
				uid: labeledInfo.podUID,
				name: containerInfo.name,
			};
			evictUnits.append(key, containerInfo);
		}
		return [evictUnits, undefined];
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go containerGC.evictContainers.
	async evictContainers(
		ctx: context.Context,
		gcPolicy: GCPolicy,
		allSourcesReady: boolean,
		evictNonDeletedPods: boolean,
	): Promise<Error | undefined> {
		const [evictUnits, err] = await this.evictableContainers(ctx, gcPolicy.minAgeMs ?? 0);
		if (err) {
			return err;
		}

		if (allSourcesReady) {
			for (const key of evictUnits.keys()) {
				const unit = evictUnits.get(key) ?? [];
				if (
					(await this.podStateProvider.shouldPodContentBeRemoved(key.uid)) ||
					(evictNonDeletedPods && (await this.podStateProvider.shouldPodRuntimeBeRemoved(key.uid)))
				) {
					await this.removeOldestN(ctx, unit, unit.length);
					evictUnits.delete(key);
				}
			}
		}

		if ((gcPolicy.maxPerPodContainer ?? 0) >= 0) {
			await this.enforceMaxContainersPerEvictUnit(
				ctx,
				evictUnits,
				gcPolicy.maxPerPodContainer ?? 0,
			);
		}

		if (
			(gcPolicy.maxContainers ?? 0) >= 0 &&
			evictUnits.numContainers() > (gcPolicy.maxContainers ?? 0)
		) {
			let numContainersPerEvictUnit = Math.trunc(
				(gcPolicy.maxContainers ?? 0) / evictUnits.numEvictUnits(),
			);
			if (numContainersPerEvictUnit < 1) {
				numContainersPerEvictUnit = 1;
			}
			await this.enforceMaxContainersPerEvictUnit(ctx, evictUnits, numContainersPerEvictUnit);

			const numContainers = evictUnits.numContainers();
			if (numContainers > (gcPolicy.maxContainers ?? 0)) {
				const flattened: ContainerGCInfo[] = [];
				for (const key of evictUnits.keys()) {
					flattened.push(...(evictUnits.get(key) ?? []));
				}
				flattened.sort(byCreated);
				await this.removeOldestN(ctx, flattened, numContainers - (gcPolicy.maxContainers ?? 0));
			}
		}
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go containerGC.evictSandboxes.
	async evictSandboxes(
		ctx: context.Context,
		evictNonDeletedPods: boolean,
	): Promise<Error | undefined> {
		const [containers, containerErr] = await this.manager.getContainers(ctx, {});
		if (containerErr) {
			return containerErr;
		}

		const [sandboxes, sandboxErr] = await this.manager.getSandboxes(ctx, {});
		if (sandboxErr) {
			return sandboxErr;
		}

		const sandboxIDs = new Set<string>();
		for (const container of containers) {
			sandboxIDs.add(container.podSandboxId);
		}

		const sandboxesByPod = new SandboxesByPodUID();
		for (const sandbox of sandboxes) {
			const podUID = sandbox.metadata.uid;
			const sandboxInfo: SandboxGCInfo = {
				id: sandbox.id,
				createTime: sandbox.createdAt,
				active: sandbox.state === "Ready" || sandboxIDs.has(sandbox.id),
			};
			sandboxesByPod.append(podUID, sandboxInfo);
		}

		for (const podUID of sandboxesByPod.keys()) {
			const sandboxes = sandboxesByPod.get(podUID) ?? [];
			if (
				(await this.podStateProvider.shouldPodContentBeRemoved(podUID)) ||
				(evictNonDeletedPods && (await this.podStateProvider.shouldPodRuntimeBeRemoved(podUID)))
			) {
				await this.removeOldestNSandboxes(ctx, sandboxes, sandboxes.length);
			} else {
				await this.removeOldestNSandboxes(ctx, sandboxes, sandboxes.length - 1);
			}
		}
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go containerGC.evictPodLogsDirectories.
	async evictPodLogsDirectories(
		_ctx: context.Context,
		_allSourcesReady: boolean,
	): Promise<Error | undefined> {
		// Upstream removes pod log directories and dead container log symlinks here.
		// The simulator does not currently model kubelet log files.
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go containerGC.GarbageCollect.
	async garbageCollect(
		ctx: context.Context,
		gcPolicy: GCPolicy,
		allSourcesReady: boolean,
		evictNonDeletedPods: boolean,
	): Promise<Error | undefined> {
		const errors: Array<Error | undefined> = [];
		errors.push(await this.evictContainers(ctx, gcPolicy, allSourcesReady, evictNonDeletedPods));
		errors.push(await this.evictSandboxes(ctx, evictNonDeletedPods));
		errors.push(await this.evictPodLogsDirectories(ctx, allSourcesReady));
		return newAggregate(errors);
	}
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go newContainerGC.
export function newContainerGC(
	client: RuntimeService,
	podStateProvider: PodStateProvider,
	manager: KubeGenericRuntimeManager,
): ContainerGC {
	return new ContainerGC(client, podStateProvider, manager);
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go containerGCInfo.
interface ContainerGCInfo {
	id: string;
	name: string;
	createTime: number;
	unknown: boolean;
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go sandboxGCInfo.
interface SandboxGCInfo {
	id: string;
	createTime: number;
	active: boolean;
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go evictUnit.
interface EvictUnit {
	uid: string;
	name: string;
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go containersByEvictUnit.
class ContainersByEvictUnit {
	private readonly items = new Map<string, { key: EvictUnit; value: ContainerGCInfo[] }>();

	keys(): EvictUnit[] {
		return [...this.items.values()].map((item) => item.key);
	}

	get(key: EvictUnit): ContainerGCInfo[] | undefined {
		return this.items.get(evictUnitKey(key))?.value;
	}

	set(key: EvictUnit, value: ContainerGCInfo[]): void {
		this.items.set(evictUnitKey(key), { key, value });
	}

	delete(key: EvictUnit): void {
		this.items.delete(evictUnitKey(key));
	}

	append(key: EvictUnit, value: ContainerGCInfo): void {
		const existing = this.get(key) ?? [];
		existing.push(value);
		this.set(key, existing);
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go containersByEvictUnit.NumContainers.
	numContainers(): number {
		let num = 0;
		for (const { value } of this.items.values()) {
			num += value.length;
		}
		return num;
	}

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go containersByEvictUnit.NumEvictUnits.
	numEvictUnits(): number {
		return this.items.size;
	}
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go sandboxesByPodUID.
class SandboxesByPodUID {
	private readonly items = new Map<string, SandboxGCInfo[]>();

	keys(): string[] {
		return [...this.items.keys()];
	}

	get(key: string): SandboxGCInfo[] | undefined {
		return this.items.get(key);
	}

	append(key: string, value: SandboxGCInfo): void {
		const existing = this.items.get(key) ?? [];
		existing.push(value);
		this.items.set(key, existing);
	}
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go byCreated.
function byCreated(left: ContainerGCInfo, right: ContainerGCInfo): number {
	return right.createTime - left.createTime;
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go sandboxByCreated.
function sandboxByCreated(left: SandboxGCInfo, right: SandboxGCInfo): number {
	return right.createTime - left.createTime;
}

function evictUnitKey(key: EvictUnit): string {
	return `${key.uid}\0${key.name}`;
}
