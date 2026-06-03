import type { V1Container, V1Pod, V1Probe } from "../../../client";
import { Channel, select } from "../../../go/channel";
import type { Context } from "../../../go/context";
import * as time from "../../../go/time";
import * as podutil from "../../api/v1/pod/util";
import { type ContainerID, parseContainerID, shouldAllContainersRestart } from "../container";
import type { ProbeManagerImpl } from "./prober-manager";
import type { ProberResult, ProbeType, ResultsManager } from "./results";

export class ProbeWorker {
	readonly pod: V1Pod;
	readonly container: V1Container;
	spec: V1Probe;
	readonly probeType: ProbeType;
	readonly initialValue: ProberResult;
	readonly resultsManager: ResultsManager;
	readonly probeManager: ProbeManagerImpl;
	private readonly intervalMs: number;
	private readonly stopCh = new Channel<void>(1);
	private readonly manualTriggerCh = new Channel<void>(1);
	containerId: ContainerID | undefined;
	lastResult: ProberResult | undefined;
	resultRun = 0;
	onHold = false;

	// Models kubernetes/pkg/kubelet/prober/worker.go newWorker.
	constructor(
		probeManager: ProbeManagerImpl,
		probeType: ProbeType,
		pod: V1Pod,
		container: V1Container,
	) {
		this.pod = pod;
		this.container = container;
		this.probeType = probeType;
		this.probeManager = probeManager;
		[this.spec, this.resultsManager, this.initialValue] = probeWorkerConfig(
			probeManager,
			probeType,
			container,
		);
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
		const sinceStart = this.probeManager.clock.nowMs() - this.probeManager.startedAt.getTime();
		if (probeTickerPeriod > sinceStart) {
			const delay = time.after(this.probeManager.clock, Math.random() * probeTickerPeriod);
			const selected = await select()
				.case(ctx.done(), () => "stop")
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

		const probeTicker = new time.Ticker(this.probeManager.clock, probeTickerPeriod);
		try {
			for (; await this.doProbe(ctx); ) {
				const selected = await select()
					.case(ctx.done(), () => "stop")
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
	async doProbe(ctx: Context): Promise<boolean> {
		if (ctx.err()) {
			return false;
		}
		const status = this.probeManager.statusManager.getPodStatus(this.pod.metadata?.uid ?? "");
		if (!status) {
			return true;
		}

		if (status.phase === "Failed" || status.phase === "Succeeded") {
			return false;
		}

		const c =
			podutil.getContainerStatus(status.containerStatuses, this.container.name) ??
			podutil.getContainerStatus(status.initContainerStatuses, this.container.name);
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
			if (!c.state?.terminated) {
				return true;
			}
			if (shouldAllContainersRestart(this.pod, undefined, status)) {
				return true;
			}
			return podutil.containerShouldRestart(
				this.container,
				this.pod.spec,
				c.state.terminated.exitCode,
			);
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
		if (startedAt !== undefined && this.probeManager.clock.nowMs() < startedAt + initialDelayMs) {
			return true;
		}

		if (c.started) {
			if (this.probeType === "startup") {
				return true;
			}
		} else if (this.probeType !== "startup") {
			return true;
		}

		const [result, err] = await this.probeManager.prober.probe(
			ctx,
			this.probeType,
			this.pod,
			status,
			this.container,
			this.containerId,
		);
		if (err) {
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

function probeWorkerConfig(
	probeManager: ProbeManagerImpl,
	probeType: ProbeType,
	container: V1Container,
): [spec: V1Probe, resultsManager: ResultsManager, initialValue: ProberResult] {
	switch (probeType) {
		case "readiness":
			return [
				requiredProbe(container.readinessProbe, probeType),
				probeManager.readinessManager,
				"failure",
			];
		case "liveness":
			return [
				requiredProbe(container.livenessProbe, probeType),
				probeManager.livenessManager,
				"success",
			];
		case "startup":
			return [
				requiredProbe(container.startupProbe, probeType),
				probeManager.startupManager,
				"unknown",
			];
	}
}

function requiredProbe(probe: V1Probe | undefined, probeType: ProbeType): V1Probe {
	if (probe === undefined) {
		throw new Error(`${probeType} probe is required`);
	}
	return probe;
}
