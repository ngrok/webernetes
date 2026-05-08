import type { V1Container, V1Pod, V1PodStatus } from "../../client";
import type { Clock } from "../../clock";
import type { Runtime } from "../cri";
import { ProbeWorker } from "./worker";
import { ResultsManager, type ProbeResult, type ProbeType } from "./results";

export interface ProbeManagerOptions {
	clock: Clock;
	runtime: Runtime;
}

export class ProbeManager {
	readonly livenessManager = new ResultsManager();
	readonly readinessManager = new ResultsManager();
	readonly startupManager = new ResultsManager();
	private readonly workers = new Map<string, ProbeWorker>();

	constructor(private readonly options: ProbeManagerOptions) {}

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

	removePod(pod: V1Pod): void {
		const uid = pod.metadata?.uid ?? "";
		for (const [key, worker] of [...this.workers]) {
			if (key.startsWith(`${uid}:`)) {
				worker.stop();
				this.workers.delete(key);
			}
		}
	}

	stopLivenessAndStartup(pod: V1Pod): void {
		const uid = pod.metadata?.uid ?? "";
		for (const [key, worker] of [...this.workers]) {
			if (key.startsWith(`${uid}:`) && (key.endsWith(":liveness") || key.endsWith(":startup"))) {
				worker.stop();
				this.workers.delete(key);
			}
		}
	}

	updatePodStatus(pod: V1Pod, status: V1PodStatus): void {
		for (const containerStatus of status.containerStatuses ?? []) {
			const container = pod.spec?.containers.find(
				(container) => container.name === containerStatus.name,
			);
			if (!container) {
				continue;
			}
			const containerId = simulatorContainerId(containerStatus.containerID);
			const running = containerStatus.state?.running !== undefined;
			if (!running || !containerId) {
				containerStatus.started = false;
				containerStatus.ready = false;
				continue;
			}

			const hasStartup = this.hasWorker(pod, container, "startup");
			containerStatus.started = hasStartup
				? this.startupManager.get(containerId) === "success"
				: true;

			if (!containerStatus.started) {
				containerStatus.ready = false;
				continue;
			}

			if (this.hasWorker(pod, container, "readiness")) {
				containerStatus.ready = this.readinessManager.get(containerId) === "success";
				if (!containerStatus.ready) {
					this.worker(pod, container, "readiness")?.triggerManualRun();
				}
			} else {
				containerStatus.ready = true;
			}
		}
	}

	result(probeType: ProbeType, containerId: string): ProbeResult | undefined {
		return this.results(probeType).get(containerId);
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
			runtime: this.options.runtime,
			results: this.results(probeType),
			pod,
			container,
			probe,
			probeType,
			hasStartupProbe: container.startupProbe !== undefined,
			startupResults: this.startupManager,
		});
		this.workers.set(key, worker);
		worker.start();
	}

	private hasWorker(pod: V1Pod, container: V1Container, probeType: ProbeType): boolean {
		return this.workers.has(this.key(pod, container, probeType));
	}

	private worker(
		pod: V1Pod,
		container: V1Container,
		probeType: ProbeType,
	): ProbeWorker | undefined {
		return this.workers.get(this.key(pod, container, probeType));
	}

	private key(pod: V1Pod, container: V1Container, probeType: ProbeType): string {
		return `${pod.metadata?.uid ?? ""}:${container.name}:${probeType}`;
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

function simulatorContainerId(containerId: string | undefined): string | undefined {
	return containerId?.startsWith("simulator://")
		? containerId.slice("simulator://".length)
		: undefined;
}
