import type { V1Container, V1ContainerStatus, V1Pod, V1PodStatus } from "../../../client";
import type { Clock } from "../../../clock";
import type { Runtime } from "../../cri";
import { type ContainerID, parseContainerID } from "../container";
import type { StatusManager } from "../status";
import { Prober } from "./prober";
import { ProbeWorker } from "./worker";
import { ResultsManager, type ProberResult, type ProbeType } from "./results";

export interface ProbeManagerOptions {
	clock: Clock;
	runtime: Runtime;
	statusManager: StatusManager;
}

export class ProbeManager {
	readonly livenessManager = new ResultsManager();
	readonly readinessManager = new ResultsManager();
	readonly startupManager = new ResultsManager();
	readonly prober: Prober;
	readonly runtime: Runtime;
	readonly statusManager: StatusManager;
	private readonly workers = new Map<string, ProbeWorker>();
	private readonly start: Date;

	constructor(private readonly options: ProbeManagerOptions) {
		this.prober = new Prober(options.runtime);
		this.runtime = options.runtime;
		this.statusManager = options.statusManager;
		this.start = options.clock.now();
	}

	get startedAt(): Date {
		return this.start;
	}

	// Models kubernetes/pkg/kubelet/prober/prober_manager.go AddPod.
	addPod(pod: V1Pod): void {
		// TODO: if we ever support init containers, we'll need to make
		// sure to add init containers with restart always to this list.
		for (const container of pod.spec?.containers ?? []) {
			if (container.startupProbe) {
				this.addWorker(pod, container, "startup");
			}
			if (container.readinessProbe) {
				this.addWorker(pod, container, "readiness");
			}
			if (container.livenessProbe) {
				this.addWorker(pod, container, "liveness");
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
				const worker = this.workers.get(probeKeyString(key));
				if (worker) {
					worker.stop();
				}
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
				const worker = this.workers.get(probeKeyString(key));
				if (worker) {
					worker.stop();
				}
			}
		}
	}

	// Models kubernetes/pkg/kubelet/prober/prober_manager.go CleanupPods.
	cleanupPods(desiredPods: Set<string>): void {
		for (const [key, worker] of this.workers) {
			if (!desiredPods.has(probeKeyPodUid(key))) {
				worker.stop();
			}
		}
	}

	// Models kubernetes/pkg/kubelet/prober/prober_manager.go UpdatePodStatus.
	updatePodStatus(pod: V1Pod, status: V1PodStatus): void {
		for (const containerStatus of status.containerStatuses ?? []) {
			const started = this.isContainerStarted(pod, containerStatus);
			containerStatus.started = started;

			if (!started) {
				continue;
			}

			const containerId = parseContainerID(containerStatus.containerID);
			let ready: boolean;
			if (!containerStatus.state?.running || !containerId.id) {
				ready = false;
			} else if (this.readinessManager.get(containerId) === "success") {
				ready = true;
			} else {
				const worker = this.getWorker(pod.metadata?.uid ?? "", containerStatus.name, "readiness");
				ready = worker === undefined;
				if (worker) {
					worker.triggerManualRun();
				}

				const containerSpec = pod.spec?.containers.find(
					(container) => container.name === containerStatus.name,
				);
				if (containerSpec) {
					ready = this.setReadyStateOnKubeletRestart(ready, pod, containerStatus, containerSpec);
				}
			}
			containerStatus.ready = ready;
		}
	}

	result(probeType: ProbeType, containerId: ContainerID): ProberResult | undefined {
		return this.results(probeType).get(containerId);
	}

	removeWorker(podUid: string, containerName: string, probeType: ProbeType): void {
		this.workers.delete(probeKeyString({ podUid, containerName, probeType }));
	}

	close(): void {
		for (const worker of this.workers.values()) {
			worker.stop();
		}
		this.workers.clear();
		this.livenessManager.close();
		this.readinessManager.close();
		this.startupManager.close();
	}

	private getProbe(container: V1Container, probeType: ProbeType) {
		switch (probeType) {
			case "liveness":
				return container.livenessProbe;
			case "readiness":
				return container.readinessProbe;
			case "startup":
				return container.startupProbe;
		}
	}

	private addWorker(pod: V1Pod, container: V1Container, probeType: ProbeType): void {
		const probe = this.getProbe(container, probeType);
		if (!probe) {
			return;
		}
		const key = this.key(pod, container, probeType);
		if (this.workers.has(key)) {
			return;
		}
		const worker = new ProbeWorker({
			clock: this.options.clock,
			probeManager: this,
			results: this.results(probeType),
			pod,
			container,
			probe,
			probeType,
		});
		this.workers.set(key, worker);
		void worker.run();
	}

	// Models kubernetes/pkg/kubelet/prober/prober_manager.go isContainerStarted.
	private isContainerStarted(pod: V1Pod, containerStatus: V1ContainerStatus): boolean {
		if (!containerStatus.state?.running) {
			return false;
		}

		const containerId = parseContainerID(containerStatus.containerID);
		if (containerId.id && this.startupManager.get(containerId) === "success") {
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
			containerStartTime < kubeletRestartGracePeriod(this.start)
		) {
			if (!ready) {
				const containerId = parseContainerID(containerStatus.containerID);
				if (!this.readinessManager.get(containerId)) {
					ready = true;
				}
			}
			if (containerSpec.readinessProbe) {
				let podIsReady = false;
				for (const condition of pod.status?.conditions ?? []) {
					if (condition.type === "Ready" && condition.status === "True") {
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
		return this.workers.get(probeKeyString({ podUid, containerName, probeType }));
	}

	private key(pod: V1Pod, container: V1Container, probeType: ProbeType): string {
		return probeKeyString({
			podUid: pod.metadata?.uid ?? "",
			containerName: container.name,
			probeType,
		});
	}

	private results(probeType: ProbeType): ResultsManager {
		switch (probeType) {
			case "liveness":
				return this.livenessManager;
			case "readiness":
				return this.readinessManager;
			case "startup":
				return this.startupManager;
		}
	}
}

function probeKeyString(key: {
	podUid: string;
	containerName: string;
	probeType: ProbeType;
}): string {
	return `${key.podUid}:${key.containerName}:${key.probeType}`;
}

function probeKeyPodUid(key: string): string {
	return key.split(":", 1)[0] ?? "";
}

function kubeletRestartGracePeriod(start: Date): Date {
	return new Date(start.getTime() - 10_000);
}
