/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1Container, V1ContainerStatus, V1Pod, V1PodStatus } from "../../../client";
import type { EventRecorder } from "../../../client-go/tools/record/event";
import type { Clock } from "../../../clock";
import { KeyFnMap } from "../../../collections";
import type { Context } from "../../../go/context";
import type { ClusterNetwork } from "../../cni";
import { parseContainerID, type CommandRunner } from "../container";
import type { StatusManager } from "../status";
import { Prober } from "./prober";
import { ProbeWorker } from "./worker";
import { ResultsManager, type ProbeType } from "./results";

// Models kubernetes/pkg/kubelet/prober/prober_manager.go Manager.
export interface ProbeManager {
	addPod(ctx: Context, pod: V1Pod): void;
	stopLivenessAndStartup(pod: V1Pod): void;
	removePod(pod: V1Pod): void;
	cleanupPods(desiredPods: Set<string>): void;
	updatePodStatus(ctx: Context, pod: V1Pod, podStatus: V1PodStatus): void;
}

interface ProbeKey {
	podUid: string;
	containerName: string;
	probeType: ProbeType;
}

export class ProbeManagerImpl implements ProbeManager {
	readonly livenessManager: ResultsManager;
	readonly readinessManager: ResultsManager;
	readonly startupManager: ResultsManager;
	readonly prober: Prober;
	readonly statusManager: StatusManager;
	readonly clock: Clock;
	readonly workers = new KeyFnMap<ProbeKey, ProbeWorker>(probeKeyString);
	// Go starts probe workers as goroutines and does not retain join handles.
	// This simulator keeps the returned promises so close() can stop workers
	// through their stop channel and then wait for their async cleanup to finish
	// before the cluster clock and runtime are torn down.
	private readonly workerRuns = new Map<ProbeWorker, Promise<void>>();
	readonly startedAt: Date;

	constructor(
		ctx: Context,
		statusManager: StatusManager,
		livenessManager: ResultsManager,
		readinessManager: ResultsManager,
		startupManager: ResultsManager,
		runner: CommandRunner | undefined,
		recorder: EventRecorder | undefined,
		clock: Clock,
		network: ClusterNetwork,
	) {
		this.clock = clock;
		this.livenessManager = livenessManager;
		this.readinessManager = readinessManager;
		this.startupManager = startupManager;
		this.prober = new Prober(ctx, runner, clock, network, recorder);
		this.statusManager = statusManager;
		this.startedAt = clock.now();
	}

	// Models kubernetes/pkg/kubelet/prober/prober_manager.go AddPod.
	addPod(ctx: Context, pod: V1Pod): void {
		// TODO: if we ever support init containers, we'll need to make
		// sure to add init containers with restart always to this list.
		const key = {
			podUid: pod.metadata?.uid ?? "",
			// Upstream only sets podUid here. We're setting these other two
			// because they're required fields and these are the Go zero values
			// for them, they both get overwritten later.
			containerName: "",
			probeType: "startup" as ProbeType,
		};
		for (const c of pod.spec?.containers ?? []) {
			key.containerName = c.name;

			if (c.startupProbe) {
				key.probeType = "startup";
				if (this.workers.has(key)) {
					return;
				}
				const w = new ProbeWorker(this, "startup", pod, c);
				this.workers.set(key, w);
				const run = w.run(ctx).finally(() => {
					this.workerRuns.delete(w);
				});
				this.workerRuns.set(w, run);
			}

			if (c.readinessProbe) {
				key.probeType = "readiness";
				if (this.workers.has(key)) {
					return;
				}
				const w = new ProbeWorker(this, "readiness", pod, c);
				this.workers.set(key, w);
				const run = w.run(ctx).finally(() => {
					this.workerRuns.delete(w);
				});
				this.workerRuns.set(w, run);
			}

			if (c.livenessProbe) {
				key.probeType = "liveness";
				if (this.workers.has(key)) {
					return;
				}
				const w = new ProbeWorker(this, "liveness", pod, c);
				this.workers.set(key, w);
				const run = w.run(ctx).finally(() => {
					this.workerRuns.delete(w);
				});
				this.workerRuns.set(w, run);
			}
		}
	}

	// Models kubernetes/pkg/kubelet/prober/prober_manager.go StopLivenessAndStartup.
	stopLivenessAndStartup(pod: V1Pod): void {
		const key = {
			podUid: pod.metadata?.uid ?? "",
			// Upstream only sets podUid here. We're setting these other two
			// because they're required fields and these are the Go zero values
			// for them, they both get overwritten later.
			containerName: "",
			probeType: "liveness" as ProbeType,
		};
		for (const container of pod.spec?.containers ?? []) {
			key.containerName = container.name;
			for (const probeType of ["liveness", "startup"] as const) {
				key.probeType = probeType;
				const worker = this.workers.get(key);
				if (worker) {
					worker.stop();
				}
			}
		}
	}

	// Models kubernetes/pkg/kubelet/prober/prober_manager.go RemovePod.
	removePod(pod: V1Pod): void {
		const key = {
			podUid: pod.metadata?.uid ?? "",
			// Upstream only sets podUid here. We're setting these other two
			// because they're required fields and these are the Go zero values
			// for them, they both get overwritten later.
			containerName: "",
			probeType: "readiness" as ProbeType,
		};
		for (const container of pod.spec?.containers ?? []) {
			key.containerName = container.name;
			for (const probeType of ["readiness", "liveness", "startup"] as const) {
				key.probeType = probeType;
				const worker = this.workers.get(key);
				if (worker) {
					worker.stop();
				}
			}
		}
	}

	// Models kubernetes/pkg/kubelet/prober/prober_manager.go CleanupPods.
	cleanupPods(desiredPods: Set<string>): void {
		for (const [key, worker] of this.workers) {
			if (!desiredPods.has(key.podUid)) {
				worker.stop();
			}
		}
	}

	// Models kubernetes/pkg/kubelet/prober/prober_manager.go UpdatePodStatus.
	updatePodStatus(_ctx: Context, pod: V1Pod, podStatus: V1PodStatus): void {
		for (const c of podStatus.containerStatuses ?? []) {
			const started = this.isContainerStarted(pod, c);
			// Upstream writes through podStatus.ContainerStatuses[i] because Go
			// range variables are copies. TypeScript iterates object references
			// here, so mutating c updates the status entry in the array.
			c.started = started;

			if (!started) {
				continue;
			}

			let ready: boolean;
			if (!c.state?.running) {
				ready = false;
			} else if (this.readinessManager.get(parseContainerID(c.containerID)) === "success") {
				ready = true;
			} else {
				const w = this.getWorker(pod.metadata?.uid ?? "", c.name, "readiness");
				const exists = w !== undefined;
				ready = !exists;
				if (exists) {
					w.triggerManualRun();
				}

				const containerSpec = pod.spec?.containers.find((container) => container.name === c.name);
				if (containerSpec) {
					ready = this.setReadyStateOnKubeletRestart(ready, pod, c, containerSpec);
				}
			}
			c.ready = ready;
		}

		// Upstream there's a whole extra section here that does an exact copy of
		// the above but for init containers. I've actually noticed throughout k8s
		// that this pattern is quite common, making it feel like init containers
		// were sort of bolted on to k8s in a bit of a hurry.
	}

	// Models kubernetes/pkg/kubelet/prober/prober_manager.go removeWorker.
	removeWorker(podUid: string, containerName: string, probeType: ProbeType): void {
		this.workers.delete({ podUid, containerName, probeType });
	}

	// Models kubernetes/pkg/kubelet/prober/prober_manager.go workerCount.
	workerCount(): number {
		return this.workers.size;
	}

	// Upstream has no prober manager Close method. This simulator adds one so
	// tests and callers can fully tear down clusters when they are done with
	// them.
	async close(): Promise<void> {
		for (const worker of this.workers.values()) {
			worker.stop();
		}
		await Promise.all(this.workerRuns.values());
	}

	// Models kubernetes/pkg/kubelet/prober/prober_manager.go isContainerStarted.
	private isContainerStarted(pod: V1Pod, containerStatus: V1ContainerStatus): boolean {
		if (!containerStatus.state?.running) {
			return false;
		}

		const result = this.startupManager.get(parseContainerID(containerStatus.containerID));
		if (result !== undefined) {
			return result === "success";
		}

		if (containerStatus.started === true) {
			return true;
		}

		if (this.getWorker(pod.metadata?.uid ?? "", containerStatus.name, "startup")) {
			return false;
		}

		return true;
	}

	// Models kubernetes/pkg/kubelet/prober/prober_manager.go setReadyStateOnKubeletRestart.
	private setReadyStateOnKubeletRestart(
		ready: boolean,
		pod: V1Pod,
		containerStatus: V1ContainerStatus,
		containerSpec: V1Container,
	): boolean {
		const containerStartTime = containerStatus.state?.running?.startedAt;

		if (
			containerStartTime !== undefined &&
			containerStartTime < kubeletRestartGracePeriod(this.startedAt)
		) {
			if (!ready) {
				const containerId = parseContainerID(containerStatus.containerID);
				if (!this.readinessManager.get(containerId)) {
					ready = true;
				}
			}
			if (containerSpec.readinessProbe) {
				let podIsReady = false;
				for (const c of pod.status?.conditions ?? []) {
					if (c.type === "Ready" && c.status === "True") {
						podIsReady = true;
						break;
					}
				}
				if (!podIsReady) {
					ready = false;
				}
			}
		}
		return ready;
	}

	getWorker(podUid: string, containerName: string, probeType: ProbeType): ProbeWorker | undefined {
		return this.workers.get({ podUid, containerName, probeType });
	}
}

function probeKeyString(key: ProbeKey): string {
	return `${key.podUid}:${key.containerName}:${key.probeType}`;
}

// Models kubernetes/pkg/kubelet/prober/prober_manager.go probeType.String.
export function probeTypeString(probeType: ProbeType): string {
	switch (probeType) {
		case "readiness":
			return "Readiness";
		case "liveness":
			return "Liveness";
		case "startup":
			return "Startup";
	}
}

// Models kubernetes/pkg/kubelet/prober/prober_manager.go kubeletRestartGracePeriod.
function kubeletRestartGracePeriod(start: Date): Date {
	return new Date(start.getTime() - 10_000);
}
