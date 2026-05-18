import type { V1Container, V1ContainerStatus, V1Pod, V1PodStatus } from "../../../client";
import type { Clock } from "../../../clock";
import type { Context } from "../../../go/context";
import type { Runtime } from "../../cri";
import { parseContainerID } from "../container";
import type { StatusManager } from "../status";
import { Prober } from "./prober";
import { ProbeWorker } from "./worker";
import { ResultsManager, type ProbeType } from "./results";

export interface ProbeManagerOptions {
	clock: Clock;
	runtime: Runtime;
	statusManager: StatusManager;
}

interface ProbeKey {
	podUid: string;
	containerName: string;
	probeType: ProbeType;
}

export class ProbeManager {
	readonly livenessManager = new ResultsManager();
	readonly readinessManager = new ResultsManager();
	readonly startupManager = new ResultsManager();
	readonly prober: Prober;
	readonly runtime: Runtime;
	readonly statusManager: StatusManager;
	private readonly workers = new WorkerMap();
	// Go starts probe workers as goroutines and does not retain join handles.
	// This simulator keeps the returned promises so close() can stop workers
	// through their stop channel and then wait for their async cleanup to finish
	// before the cluster clock and runtime are torn down.
	private readonly workerRuns = new Map<ProbeWorker, Promise<void>>();
	readonly startedAt: Date;

	constructor(private readonly options: ProbeManagerOptions) {
		this.prober = new Prober(options.runtime);
		this.runtime = options.runtime;
		this.statusManager = options.statusManager;
		this.startedAt = options.clock.now();
	}

	// Models kubernetes/pkg/kubelet/prober/prober_manager.go AddPod.
	addPod(ctx: Context, pod: V1Pod): void {
		// TODO: if we ever support init containers, we'll need to make
		// sure to add init containers with restart always to this list.
		const key = {
			podUid: pod.metadata?.uid ?? "",
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
				const w = new ProbeWorker({
					clock: this.options.clock,
					probeManager: this,
					results: this.startupManager,
					pod,
					container: c,
					probe: c.startupProbe,
					probeType: "startup",
				});
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
				const w = new ProbeWorker({
					clock: this.options.clock,
					probeManager: this,
					results: this.readinessManager,
					pod,
					container: c,
					probe: c.readinessProbe,
					probeType: "readiness",
				});
				this.workers.set(key, w);
				const run = w.run(ctx).finally(() => {
					this.workerRuns.delete(w);
				});
				this.workerRuns.set(w, run);
				void run;
			}

			if (c.livenessProbe) {
				key.probeType = "liveness";
				if (this.workers.has(key)) {
					return;
				}
				const w = new ProbeWorker({
					clock: this.options.clock,
					probeManager: this,
					results: this.livenessManager,
					pod,
					container: c,
					probe: c.livenessProbe,
					probeType: "liveness",
				});
				this.workers.set(key, w);
				const run = w.run(ctx).finally(() => {
					this.workerRuns.delete(w);
				});
				this.workerRuns.set(w, run);
				void run;
			}
		}
	}

	// Models kubernetes/pkg/kubelet/prober/prober_manager.go StopLivenessAndStartup.
	stopLivenessAndStartup(pod: V1Pod): void {
		const key = {
			podUid: pod.metadata?.uid ?? "",
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
	updatePodStatus(pod: V1Pod, podStatus: V1PodStatus): void {
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

	// workerCount returns the total number of probe workers. For testing.
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

	private getWorker(
		podUid: string,
		containerName: string,
		probeType: ProbeType,
	): ProbeWorker | undefined {
		return this.workers.get({ podUid, containerName, probeType });
	}
}

// This exists because in Golang you can use structs as map keys and they
// compare by value, but in TypeScript objects compare by identity. In order
// for the code to look as close as possible to Go I've made this little Map
// wrapper that uses a string key derived from the ProbeKey struct.
class WorkerMap implements Iterable<[ProbeKey, ProbeWorker]> {
	private readonly workers = new Map<string, { key: ProbeKey; worker: ProbeWorker }>();

	get size(): number {
		return this.workers.size;
	}

	has(key: ProbeKey): boolean {
		return this.workers.has(probeKeyString(key));
	}

	get(key: ProbeKey): ProbeWorker | undefined {
		return this.workers.get(probeKeyString(key))?.worker;
	}

	set(key: ProbeKey, worker: ProbeWorker): void {
		this.workers.set(probeKeyString(key), {
			// We store key for the iterator later.
			key: { ...key },
			worker,
		});
	}

	delete(key: ProbeKey): void {
		this.workers.delete(probeKeyString(key));
	}

	*values(): IterableIterator<ProbeWorker> {
		for (const { worker } of this.workers.values()) {
			yield worker;
		}
	}

	*[Symbol.iterator](): IterableIterator<[ProbeKey, ProbeWorker]> {
		for (const { key, worker } of this.workers.values()) {
			yield [key, worker];
		}
	}
}

function probeKeyString(key: ProbeKey): string {
	return `${key.podUid}:${key.containerName}:${key.probeType}`;
}

// Models kubernetes/pkg/kubelet/prober/prober_manager.go kubeletRestartGracePeriod.
function kubeletRestartGracePeriod(start: Date): Date {
	return new Date(start.getTime() - 10_000);
}
