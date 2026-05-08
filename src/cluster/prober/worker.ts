import type { V1Container, V1Pod, V1Probe } from "../../client";
import type { Clock } from "../../clock";
import { Ticker } from "../../ticker";
import type { ContainerInstance, Runtime } from "../cri";
import { Prober } from "./prober";
import type { ProbeResult, ProbeType, ResultsManager } from "./results";

export interface WorkerOptions {
	clock: Clock;
	runtime: Runtime;
	results: ResultsManager;
	pod: V1Pod;
	container: V1Container;
	probe: V1Probe;
	probeType: ProbeType;
	hasStartupProbe: boolean;
	startupResults: ResultsManager;
}

class Signal {
	private _resolve: () => void = () => {};
	private _resolved = false;
	readonly promise: Promise<void>;

	constructor() {
		this.promise = new Promise<void>((resolve) => {
			this._resolve = resolve;
		});
	}

	resolve(): void {
		this._resolved = true;
		this._resolve();
	}

	get resolved(): boolean {
		return this._resolved;
	}
}

export class ProbeWorker {
	private manualRunSignal = new Signal();
	private ticker: Ticker;
	private currentContainerId: string | undefined;
	private consecutiveSuccesses = 0;
	private consecutiveFailures = 0;
	private onHold = false;
	private readonly prober: Prober;

	constructor(private readonly options: WorkerOptions) {
		this.prober = new Prober(options.runtime);

		const intervalMs = (this.options.probe.periodSeconds ?? 10) * 1000;
		this.ticker = new Ticker(this.options.clock, intervalMs);
		this.ticker.on("tick", () => this.runOnce());
	}

	start() {
		this.ticker.start();
	}

	stop() {
		this.ticker.stop();
		if (this.currentContainerId) {
			this.options.results.remove(this.currentContainerId);
			this.currentContainerId = undefined;
		}
	}

	get stopped(): boolean {
		return this.ticker === undefined;
	}

	triggerManualRun(): void {
		if (this.stopped) {
			return;
		}
		this.manualRunSignal.resolve();
	}

	private async runOnce(): Promise<void> {
		const container = this.findContainer();
		if (!container) {
			return;
		}
		if (this.currentContainerId !== container.id) {
			if (this.currentContainerId) {
				this.options.results.remove(this.currentContainerId);
			}
			this.currentContainerId = container.id;
			this.consecutiveSuccesses = 0;
			this.consecutiveFailures = 0;
			this.onHold = false;
			this.options.results.set(
				container.id,
				initialResult(this.options.probeType),
				this.options.pod,
			);
		}
		if (this.onHold || container.status().state !== "Running") {
			return;
		}
		if (
			this.options.hasStartupProbe &&
			this.options.probeType !== "startup" &&
			this.options.startupResults.get(container.id) !== "success"
		) {
			return;
		}
		const initialDelayMs = (this.options.probe.initialDelaySeconds ?? 0) * 1000;
		const startedAt = container.status().startedAt;
		if (startedAt !== undefined && this.options.clock.nowMs() < startedAt + initialDelayMs) {
			return;
		}

		const rawResult = await this.prober.probe(
			container,
			this.options.container,
			this.options.probe,
			(this.options.probe.timeoutSeconds ?? 1) * 1000,
		);
		const result = rawResult === "unknown" ? "failure" : rawResult;
		this.recordResult(container, result);
	}

	private recordResult(container: ContainerInstance, result: ProbeResult): void {
		if (result === "success") {
			this.consecutiveSuccesses++;
			this.consecutiveFailures = 0;
		} else {
			this.consecutiveFailures++;
			this.consecutiveSuccesses = 0;
		}

		const successThreshold =
			this.options.probeType === "readiness" ? (this.options.probe.successThreshold ?? 1) : 1;
		const failureThreshold = this.options.probe.failureThreshold ?? 3;
		if (result === "success" && this.consecutiveSuccesses >= successThreshold) {
			this.options.results.set(container.id, "success", this.options.pod);
			return;
		}
		if (result === "failure" && this.consecutiveFailures >= failureThreshold) {
			this.options.results.set(container.id, "failure", this.options.pod);
			if (this.options.probeType !== "readiness") {
				this.onHold = true;
			}
		}
	}

	private findContainer(): ContainerInstance | undefined {
		for (const sandbox of this.options.runtime.getPodSandboxesByPodUid(
			this.options.pod.metadata?.uid ?? "",
		)) {
			const container = [...sandbox.containers.values()]
				.filter((candidate) => candidate.name === this.options.container.name)
				.toSorted((left, right) => right.createdAt - left.createdAt)[0];
			if (container) {
				return container;
			}
		}
		return undefined;
	}
}

function initialResult(probeType: ProbeType): ProbeResult {
	switch (probeType) {
		case "readiness":
			return "failure";
		case "liveness":
			return "success";
		case "startup":
			return "unknown";
	}
}
