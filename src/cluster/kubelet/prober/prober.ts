import type { V1Container, V1Pod, V1PodStatus, V1Probe } from "../../../client";
import type { EventRecorder } from "../../../client-go/tools/record/event";
import type { Clock } from "../../../clock";
import type * as context from "../../../go/context";
import type { ClusterNetwork } from "../../cni";
import {
	expandContainerCommandOnlyStatic,
	generateContainerRef,
	type CommandRunner,
	type ContainerID,
} from "../container";
import { ExecProber, HTTPProber, TCPProber } from "../../probe";
import type { ByteWriter, ExecCmd, ExecProbe, ProbeResult } from "../../probe";
import { newRequestForHTTPGetAction } from "../../probe/http/request";
import { resolveContainerPort } from "../../probe/util";
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
		ctx: context.Context,
		readonly runner: CommandRunner | undefined,
		clock: Clock,
		network: ClusterNetwork,
		readonly recorder: EventRecorder | undefined,
	) {
		this.exec = new ExecProber();
		this.http = new HTTPProber(ctx, clock, network);
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
			ctx,
			probeType,
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
		ctx: context.Context,
		probeType: ProbeType,
		p: V1Probe,
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
				ctx,
				probeType,
				p,
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
		ctx: context.Context,
		_probeType: ProbeType,
		probe: V1Probe,
		pod: V1Pod,
		status: V1PodStatus,
		container: V1Container,
		containerId: ContainerID,
	): Promise<[ProbeResult, string, Error | undefined]> {
		const timeoutMs = (probe.timeoutSeconds ?? 1) * 1000;
		if (probe.exec) {
			const command = expandContainerCommandOnlyStatic(
				probe.exec.command ?? [],
				container.env ?? [],
			);
			return await this.exec.probe(
				this.newExecInContainer(ctx, pod, container, containerId, command, timeoutMs),
			);
		}
		if (probe.httpGet) {
			const [req, err] = newRequestForHTTPGetAction(
				probe.httpGet,
				container,
				status.podIP ?? "",
				"probe",
			);
			if (err || !req) {
				return ["unknown", "", err];
			}
			return await this.http.probe(req, timeoutMs);
		}
		if (probe.tcpSocket) {
			const [port, err] = resolveContainerPort(probe.tcpSocket.port, container);
			if (err) {
				return ["unknown", "", err];
			}
			let host = probe.tcpSocket.host ?? "";
			if (host === "") {
				host = status.podIP ?? "";
			}
			return this.tcp.probe(host, port, timeoutMs);
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

	// Models kubernetes/pkg/kubelet/prober/prober.go newExecInContainer.
	private newExecInContainer(
		ctx: context.Context,
		pod: V1Pod,
		container: V1Container,
		containerID: ContainerID,
		cmd: string[],
		timeoutMs: number,
	): ExecCmd {
		return new ExecInContainer(
			async () =>
				await (this.runner ?? new MissingCommandRunner()).runInContainer(
					ctx,
					containerID,
					cmd,
					timeoutMs / 1000,
				),
			pod,
			container,
		);
	}
}

class MissingCommandRunner implements CommandRunner {
	async runInContainer(): Promise<[string, Error | undefined]> {
		return ["", new Error("exec probe command runner is not configured")];
	}
}

class ExecInContainer implements ExecCmd {
	private writer: ByteWriter | undefined;

	constructor(
		private readonly runCommand: () => Promise<[string, Error | undefined]>,
		readonly _pod: V1Pod,
		readonly _container: V1Container,
	) {}

	run(): Error | undefined {
		return undefined;
	}

	async combinedOutput(): Promise<[string, Error | undefined]> {
		return await this.runCommand();
	}

	output(): [string, Error | undefined] {
		return ["", new Error("unimplemented")];
	}

	setDir(_dir: string): void {}

	setStdin(_input: unknown): void {}

	setStdout(out: ByteWriter): void {
		this.writer = out;
	}

	setStderr(out: ByteWriter): void {
		this.writer = out;
	}

	setEnv(_env: string[]): void {}

	stop(): void {}

	async start(): Promise<Error | undefined> {
		const [data, err] = await this.runCommand();
		if (this.writer) {
			this.writer.write(data);
		}
		return err;
	}

	async wait(): Promise<Error | undefined> {
		return undefined;
	}

	stdoutPipe(): [unknown, Error | undefined] {
		return [undefined, new Error("unimplemented")];
	}

	stderrPipe(): [unknown, Error | undefined] {
		return [undefined, new Error("unimplemented")];
	}
}
