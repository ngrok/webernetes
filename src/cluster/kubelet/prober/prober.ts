import type { V1Container, V1Pod, V1PodStatus, V1Probe } from "../../../client";
import type { EventRecorder } from "../../../client-go/tools/record/event";
import type * as context from "../../../go/context";
import type { ClusterNetwork } from "../../cni";
import { generateContainerRef, type CommandRunner, type ContainerID } from "../container";
import { ExecProber, HTTPProber, TCPProber } from "../../probe";
import type { ExecProbe, ProbeResult } from "../../probe";
import { probeTypeString } from "./prober-manager";
import type { ProbeType, ProberResult } from "./results";

// Models kubernetes/pkg/kubelet/prober/prober.go maxProbeRetries.
const maxProbeRetries = 3;

// Models kubernetes/pkg/kubelet/prober/prober.go prober.
export class Prober {
	exec: ExecProbe;
	readonly http: HTTPProber;
	readonly tcp: TCPProber;

	// Models kubernetes/pkg/kubelet/prober/prober.go newProber.
	constructor(
		readonly runner: CommandRunner | undefined,
		network: ClusterNetwork,
		readonly recorder: EventRecorder | undefined,
	) {
		this.exec = new ExecProber(runner ?? new MissingCommandRunner());
		this.http = new HTTPProber(network);
		this.tcp = new TCPProber(network);
	}

	// Models kubernetes/pkg/kubelet/prober/prober.go probe.
	async probe(
		ctx: context.Context,
		probeType: ProbeType,
		pod: V1Pod,
		status: V1PodStatus,
		container: V1Container,
		containerId: ContainerID,
	): Promise<[ProberResult, Error | undefined]> {
		const [probeSpec, probeSpecErr] = this.probeSpec(container, probeType);
		if (probeSpecErr) {
			return ["failure", probeSpecErr];
		}
		if (!probeSpec) {
			return ["success", undefined];
		}

		const [result, output, err] = await this.runProbeWithRetries(
			probeType,
			ctx,
			probeSpec,
			pod,
			status,
			container,
			containerId,
			maxProbeRetries,
		);

		if (err) {
			await this.recordContainerEvent(
				pod,
				container,
				"Warning",
				"Unhealthy",
				"%s probe errored and resulted in %s state: %s",
				probeTypeString(probeType),
				result,
				err.message,
			);
			return ["failure", err];
		}

		switch (result) {
			case "success":
				return [result, undefined];
			case "failure":
				await this.recordContainerEvent(
					pod,
					container,
					"Warning",
					"Unhealthy",
					"%s probe failed: %s",
					probeTypeString(probeType),
					output,
				);
				return [result, undefined];
			case "warning":
				await this.recordContainerEvent(
					pod,
					container,
					"Warning",
					"ProbeWarning",
					"%s probe warning: %s",
					probeTypeString(probeType),
					output,
				);
				return ["success", undefined];
			case "unknown":
				return ["failure", undefined];
			default:
				return ["failure", undefined];
		}
	}

	// Models kubernetes/pkg/kubelet/prober/prober.go runProbeWithRetries.
	private async runProbeWithRetries(
		probeType: ProbeType,
		ctx: context.Context,
		probe: V1Probe,
		pod: V1Pod,
		status: V1PodStatus,
		container: V1Container,
		containerId: ContainerID,
		retries: number,
	): Promise<[ProbeResult, string, Error | undefined]> {
		let err: Error | undefined;
		let result: ProbeResult = "unknown";
		let output = "";
		for (let i = 0; i < retries; i++) {
			[result, output, err] = await this.runProbe(
				probeType,
				ctx,
				probe,
				pod,
				status,
				container,
				containerId,
			);
			if (!err) {
				return [result, output, undefined];
			}
		}
		return [result, output, err];
	}

	// Models kubernetes/pkg/kubelet/prober/prober.go runProbe.
	private async runProbe(
		_probeType: ProbeType,
		ctx: context.Context,
		probe: V1Probe,
		pod: V1Pod,
		status: V1PodStatus,
		container: V1Container,
		containerId: ContainerID,
	): Promise<[ProbeResult, string, Error | undefined]> {
		const timeoutMs = (probe.timeoutSeconds ?? 1) * 1000;
		if (probe.exec) {
			// TODO(samwho): the call signature we have here is very different to
			// upstream, we should fix it.
			return await this.exec.probe(ctx, containerId, container, probe.exec, timeoutMs);
		}
		if (probe.httpGet) {
			// TODO(samwho): the call signature we have here is very different to
			// upstream, we should fix it.
			return [await this.http.probe(status.podIP, container, probe.httpGet), "", undefined];
		}
		if (probe.tcpSocket) {
			// TODO(samwho): the call signature we have here is very different to
			// upstream, we should fix it.
			return [this.tcp.probe(status.podIP, container, probe.tcpSocket), "", undefined];
		}
		return [
			"unknown",
			"",
			new Error(
				`missing probe handler for ${pod.metadata?.namespace ?? "default"}/${pod.metadata?.name ?? ""}:${container.name}`,
			),
		];
	}

	// Models kubernetes/pkg/kubelet/prober/prober.go probe.
	private probeSpec(
		container: V1Container,
		probeType: ProbeType,
	): [V1Probe | undefined, Error | undefined] {
		switch (probeType) {
			case "readiness":
				return [container.readinessProbe, undefined];
			case "liveness":
				return [container.livenessProbe, undefined];
			case "startup":
				return [container.startupProbe, undefined];
			default:
				return [undefined, new Error(`unknown probe type: ${probeType}`)];
		}
	}

	// Models kubernetes/pkg/kubelet/prober/prober.go recordContainerEvent.
	async recordContainerEvent(
		pod: V1Pod,
		container: V1Container,
		eventType: string,
		reason: string,
		message: string,
		...args: unknown[]
	): Promise<void> {
		if (!this.recorder) {
			return;
		}
		const [ref, err] = generateContainerRef(pod, container);
		if (err || !ref) {
			return;
		}
		await this.recorder.eventf(ref, eventType, reason, message, ...args);
	}
}

class MissingCommandRunner implements CommandRunner {
	async runInContainer(): Promise<[string, Error | undefined]> {
		return ["", new Error("exec probe command runner is not configured")];
	}
}
