import type { V1Container, V1ContainerStatus, V1Pod, V1PodStatus, V1Probe } from "../../../client";
import { Channel, select } from "../../../channel";
import type { Clock } from "../../../clock";
import { Ticker } from "../../../ticker";
import { type ContainerID, parseContainerID } from "../container";
import type { ProbeManager } from "./manager";
import type { ProberResult, ProbeType, ResultsManager } from "./results";

export interface WorkerOptions {
	clock: Clock;
	probeManager: ProbeManager;
	results: ResultsManager;
	pod: V1Pod;
	container: V1Container;
	probe: V1Probe;
	probeType: ProbeType;
	removeWorker: () => void;
}

export class ProbeWorker {
	private readonly clock: Clock;
	private readonly pod: V1Pod;
	private readonly container: V1Container;
	private readonly spec: V1Probe;
	private readonly probeType: ProbeType;
	private readonly initialValue: ProberResult;
	private readonly resultsManager: ResultsManager;
	private readonly probeManager: ProbeManager;
	private readonly removeWorker: () => void;
	private readonly intervalMs: number;
	private readonly stopCh = new Channel<void>(1);
	private readonly manualTriggerCh = new Channel<void>(1);
	private ticker: Ticker;
	private containerId: ContainerID | undefined;
	private lastResult: ProberResult | undefined;
	private resultRun = 0;
	private onHold = false;
	private stoppedState = false;

	constructor(options: WorkerOptions) {
		this.clock = options.clock;
		this.pod = options.pod;
		this.container = options.container;
		this.spec = options.probe;
		this.probeType = options.probeType;
		this.initialValue = initialResult(options.probeType);
		this.resultsManager = options.results;
		this.probeManager = options.probeManager;
		this.removeWorker = options.removeWorker;

		this.intervalMs = (this.spec.periodSeconds ?? 10) * 1000;
		this.ticker = new Ticker(this.clock, this.intervalMs);
	}

	start() {
		void this.run();
	}

	stop() {
		if (this.stoppedState) {
			return;
		}
		this.stoppedState = true;
		this.stopCh.trySend(undefined);
	}

	get stopped(): boolean {
		return this.stoppedState;
	}

	triggerManualRun(): void {
		if (this.stopped) {
			return;
		}
		this.manualTriggerCh.trySend(undefined);
	}

	// Models kubernetes/pkg/kubelet/prober/worker.go run.
	private async run(): Promise<void> {
		try {
			while (!this.stoppedState && (await this.doProbe())) {
				const selected = await select()
					.case(this.stopCh, () => "stop")
					.case(this.ticker.C, () => "tick")
					.case(this.manualTriggerCh, () => "manual");
				if (selected === "stop") {
					break;
				}
				if (selected === "manual") {
					this.ticker.reset(this.intervalMs);
				}
			}
		} finally {
			this.stoppedState = true;
			this.ticker.stop();
			if (this.containerId) {
				this.resultsManager.remove(this.containerId);
				this.containerId = undefined;
			}
			this.removeWorker();
		}
	}

	// Models kubernetes/pkg/kubelet/prober/worker.go doProbe.
	private async doProbe(): Promise<boolean> {
		const [status, ok] = this.probeManager.statusManager.getPodStatus(this.pod.metadata?.uid ?? "");
		if (!ok || !status) {
			return true;
		}

		if (status.phase === "Failed" || status.phase === "Succeeded") {
			return false;
		}

		const containerStatus = findContainerStatus(status, this.container.name);
		if (!containerStatus?.containerID) {
			return true;
		}

		const containerId = parseContainerID(containerStatus.containerID);
		if (!containerId.id) {
			return true;
		}

		if (this.containerId?.toString() !== containerId.toString()) {
			if (this.containerId) {
				this.resultsManager.remove(this.containerId);
			}
			this.containerId = containerId;
			this.lastResult = undefined;
			this.resultRun = 0;
			this.resultsManager.set(this.containerId, this.initialValue, this.pod);
			this.onHold = false;
		}

		if (this.onHold) {
			return true;
		}

		if (!containerStatus.state?.running) {
			this.resultsManager.set(this.containerId, "failure", this.pod);
			return !containerStatus.state?.terminated || this.pod.spec?.restartPolicy !== "Never";
		}

		if (
			this.pod.metadata?.deletionTimestamp !== undefined &&
			(this.probeType === "liveness" || this.probeType === "startup")
		) {
			this.resultsManager.set(this.containerId, "success", this.pod);
			return false;
		}

		const initialDelayMs = (this.spec.initialDelaySeconds ?? 0) * 1000;
		const startedAt = containerStatus.state.running.startedAt?.getTime();
		if (startedAt !== undefined && this.clock.nowMs() < startedAt + initialDelayMs) {
			return true;
		}

		if (containerStatus.started) {
			if (this.probeType === "startup") {
				return true;
			}
		} else if (this.probeType !== "startup") {
			return true;
		}

		let result: ProberResult;
		try {
			result = await this.probeManager.prober.probe(
				this.probeType,
				this.pod,
				status,
				this.container,
				this.containerId,
			);
		} catch {
			return true;
		}

		if (this.lastResult === result) {
			this.resultRun++;
		} else {
			this.lastResult = result;
			this.resultRun = 1;
		}

		const successThreshold = this.spec.successThreshold ?? 1;
		const failureThreshold = this.spec.failureThreshold ?? 3;
		if (
			(result === "failure" && this.resultRun < failureThreshold) ||
			(result === "success" && this.resultRun < successThreshold)
		) {
			return true;
		}

		this.resultsManager.set(this.containerId, result, this.pod);

		if ((this.probeType === "liveness" && result === "failure") || this.probeType === "startup") {
			this.onHold = true;
			this.resultRun = 0;
		}
		return true;
	}
}

function findContainerStatus(
	status: V1PodStatus,
	containerName: string,
): V1ContainerStatus | undefined {
	return status.containerStatuses?.find(
		(containerStatus) => containerStatus.name === containerName,
	);
}

function initialResult(probeType: ProbeType): ProberResult {
	switch (probeType) {
		case "readiness":
			return "failure";
		case "liveness":
			return "success";
		case "startup":
			return "unknown";
	}
}
