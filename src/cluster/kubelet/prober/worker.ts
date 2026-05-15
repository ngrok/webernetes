import type { V1Container, V1Pod, V1Probe } from "../../../client";
import { Channel, select } from "../../../go/channel";
import type { Context } from "../../../go/context";
import type { Clock } from "../../../clock";
import * as time from "../../../go/time";
import * as podutil from "../../pod-util";
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
	private readonly intervalMs: number;
	private readonly stopCh = new Channel<void>(1);
	private readonly manualTriggerCh = new Channel<void>(1);
	private containerId: ContainerID | undefined;
	private lastResult: ProberResult | undefined;
	private resultRun = 0;
	private onHold = false;

	constructor(options: WorkerOptions) {
		this.clock = options.clock;
		this.pod = options.pod;
		this.container = options.container;
		this.spec = options.probe;
		this.probeType = options.probeType;
		this.initialValue = initialResult(options.probeType);
		this.resultsManager = options.results;
		this.probeManager = options.probeManager;

		this.intervalMs = (this.spec.periodSeconds ?? 10) * 1000;
	}

	stop() {
		this.stopCh.trySend(undefined);
	}

	triggerManualRun(): void {
		this.manualTriggerCh.trySend(undefined);
	}

	// Models kubernetes/pkg/kubelet/prober/worker.go run.
	async run(ctx: Context): Promise<void> {
		const probeTickerPeriod = this.intervalMs;
		const sinceStart = this.clock.nowMs() - this.probeManager.startedAt.getTime();
		if (probeTickerPeriod > sinceStart) {
			const delay = time.after(this.clock, Math.random() * probeTickerPeriod);
			const selected = await select()
				.case(this.stopCh, () => "stop")
				.case(delay, () => "continue");
			if (selected !== "continue") {
				this.probeManager.removeWorker(
					this.pod.metadata?.uid ?? "",
					this.container.name,
					this.probeType,
				);
				return;
			}
		}

		const probeTicker = new time.Ticker(this.clock, probeTickerPeriod);
		try {
			for (; await this.doProbe(ctx); ) {
				const selected = await select()
					.case(this.stopCh, () => "stop")
					.case(probeTicker.C, () => "tick")
					.case(this.manualTriggerCh, () => "manual");
				if (selected === "stop") {
					break;
				}
				if (selected === "manual") {
					probeTicker.reset(probeTickerPeriod);
				}
			}
		} finally {
			probeTicker.stop();
			if (this.containerId) {
				this.resultsManager.remove(this.containerId);
			}
			this.probeManager.removeWorker(
				this.pod.metadata?.uid ?? "",
				this.container.name,
				this.probeType,
			);
		}
	}

	// Models kubernetes/pkg/kubelet/prober/worker.go doProbe.
	private async doProbe(_ctx: Context): Promise<boolean> {
		const status = this.probeManager.statusManager.getPodStatus(this.pod.metadata?.uid ?? "");
		if (!status) {
			return true;
		}

		if (status.phase === "Failed" || status.phase === "Succeeded") {
			return false;
		}

		const c = podutil.getContainerStatus(status.containerStatuses, this.container.name);
		if (!c?.containerID) {
			return true;
		}

		if (this.containerId?.toString() !== c.containerID) {
			if (this.containerId) {
				this.resultsManager.remove(this.containerId);
			}
			this.containerId = parseContainerID(c.containerID);
			await this.resultsManager.set(this.containerId, this.initialValue, this.pod);
			this.onHold = false;
		}

		if (this.onHold) {
			return true;
		}

		if (!c.state?.running) {
			await this.resultsManager.set(this.containerId, "failure", this.pod);
			return !c.state?.terminated || this.pod.spec?.restartPolicy !== "Never";
		}

		if (
			this.pod.metadata?.deletionTimestamp !== undefined &&
			(this.probeType === "liveness" || this.probeType === "startup")
		) {
			await this.resultsManager.set(this.containerId, "success", this.pod);
			return false;
		}

		const initialDelayMs = (this.spec.initialDelaySeconds ?? 0) * 1000;
		const startedAt = c.state.running.startedAt?.getTime();
		if (startedAt !== undefined && this.clock.nowMs() < startedAt + initialDelayMs) {
			return true;
		}

		if (c.started) {
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

		await this.resultsManager.set(this.containerId, result, this.pod);

		if ((this.probeType === "liveness" && result === "failure") || this.probeType === "startup") {
			this.onHold = true;
			this.resultRun = 0;
		}
		return true;
	}
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
