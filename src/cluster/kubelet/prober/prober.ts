import type { V1Container, V1Pod, V1PodStatus, V1Probe } from "../../../client";
import type * as context from "../../../go/context";
import type { ClusterNetwork } from "../../cni";
import type { CommandRunner, ContainerID } from "../container";
import { ExecProber, HTTPProber, TCPProber } from "../../probe";
import type { ProbeResult } from "../../probe";
import type { ProbeType, ProberResult } from "./results";

const MAX_PROBE_RETRIES = 3;

export class Prober {
	private readonly exec: ExecProber;
	private readonly http: HTTPProber;
	private readonly tcp: TCPProber;

	constructor(runner: CommandRunner, network: ClusterNetwork) {
		this.exec = new ExecProber(runner);
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
	): Promise<ProberResult> {
		const probeSpec = this.probeSpec(container, probeType);
		if (!probeSpec) {
			return "success";
		}

		let result: ProbeResult;
		try {
			result = await this.runProbeWithRetries(
				probeType,
				ctx,
				probeSpec,
				pod,
				status,
				container,
				containerId,
				MAX_PROBE_RETRIES,
			);
		} catch (error) {
			throw normalizeProbeError(error);
		}

		switch (result) {
			case "success":
			case "failure":
				return result;
			case "warning":
				return "success";
			case "unknown":
				return "failure";
			default:
				return "failure";
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
	): Promise<ProbeResult> {
		let lastError: unknown;
		for (let attempt = 0; attempt < retries; attempt++) {
			try {
				return await this.runProbe(probeType, ctx, probe, pod, status, container, containerId);
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError;
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
	): Promise<ProbeResult> {
		const timeoutMs = (probe.timeoutSeconds ?? 1) * 1000;
		if (probe.exec) {
			return await this.exec.probe(ctx, containerId, container, probe.exec, timeoutMs);
		}
		if (probe.httpGet) {
			return await this.http.probe(status.podIP, container, probe.httpGet);
		}
		if (probe.tcpSocket) {
			return this.tcp.probe(status.podIP, container, probe.tcpSocket);
		}
		throw new Error(
			`missing probe handler for ${pod.metadata?.namespace ?? "default"}/${pod.metadata?.name ?? ""}:${container.name}`,
		);
	}

	private probeSpec(container: V1Container, probeType: ProbeType): V1Probe | undefined {
		switch (probeType) {
			case "readiness":
				return container.readinessProbe;
			case "liveness":
				return container.livenessProbe;
			case "startup":
				return container.startupProbe;
			default:
				throw new Error(`unknown probe type: ${probeType}`);
		}
	}
}

function normalizeProbeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
