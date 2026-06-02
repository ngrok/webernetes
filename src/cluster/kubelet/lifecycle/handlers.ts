import type { V1Container, V1LifecycleHandler, V1Pod } from "../../../client";
import type { Clock } from "../../../clock";
import { select } from "../../../go/channel";
import type * as context from "../../../go/context";
import * as time from "../../../go/time";
import type { ClusterNetwork } from "../../cni";
import type { EventRecorder } from "../../../client-go/tools/record/event";
import { resolveContainerPort } from "../../probe/util";
import type { HandlerRunner, Pod as RuntimePod, PodStatus as PodRuntimeStatus } from "../container";
import type { CommandRunner, ContainerID } from "../container";
import * as format from "../util/format";

// Models kubernetes/pkg/kubelet/lifecycle/handlers.go podStatusProvider.
interface PodStatusProvider {
	getPod(
		ctx: context.Context,
		podUid: string,
	): Promise<[pod: RuntimePod | undefined, err: Error | undefined]>;
	getPodStatus(
		ctx: context.Context,
		pod: RuntimePod,
	): Promise<[podStatus: PodRuntimeStatus | undefined, err: Error | undefined]>;
}

export interface HandlerRunnerOptions {
	clock: Clock;
	commandRunner: CommandRunner;
	containerManager: PodStatusProvider;
	eventRecorder: EventRecorder;
	network: ClusterNetwork;
}

// Models kubernetes/pkg/kubelet/lifecycle/handlers.go NewHandlerRunner.
export function newHandlerRunner(options: HandlerRunnerOptions): HandlerRunner {
	return new LifecycleHandlerRunner(options);
}

// Models kubernetes/pkg/kubelet/lifecycle/handlers.go handlerRunner.
class LifecycleHandlerRunner implements HandlerRunner {
	private readonly clock: Clock;
	private readonly commandRunner: CommandRunner;
	private readonly containerManager: PodStatusProvider;
	private readonly eventRecorder: EventRecorder;
	private readonly network: ClusterNetwork;

	constructor(options: HandlerRunnerOptions) {
		this.clock = options.clock;
		this.commandRunner = options.commandRunner;
		this.containerManager = options.containerManager;
		this.eventRecorder = options.eventRecorder;
		this.network = options.network;
	}

	// Models kubernetes/pkg/kubelet/lifecycle/handlers.go handlerRunner.Run.
	async run(
		ctx: context.Context,
		containerID: ContainerID,
		pod: V1Pod,
		container: V1Container,
		handler: V1LifecycleHandler,
	): Promise<[message: string, err: Error | undefined]> {
		if (handler.exec) {
			const command = handler.exec.command ?? [];
			const [output, err] = await this.commandRunner.runInContainer(ctx, containerID, command, 0);
			if (err) {
				return [
					`Exec lifecycle hook (${command.join(" ")}) for Container "${container.name}" in Pod "${format.pod(pod)}" failed - error: ${err.message}, message: "${output}"`,
					err,
				];
			}
			return ["", undefined];
		}
		if (handler.httpGet) {
			const err = await this.runHTTPHandler(ctx, pod, container, handler, this.eventRecorder);
			if (err) {
				return [
					`HTTP lifecycle hook (${handler.httpGet.path ?? ""}) for Container "${container.name}" in Pod "${format.pod(pod)}" failed - error: ${err.message}`,
					err,
				];
			}
			return ["", undefined];
		}
		if (handler.sleep) {
			const err = await this.runSleepHandler(ctx, handler.sleep.seconds);
			if (err) {
				return [
					`Sleep lifecycle hook (${handler.sleep.seconds}) for Container "${container.name}" in Pod "${format.pod(pod)}" failed - error: ${err.message}`,
					err,
				];
			}
			return ["", undefined];
		}
		const err = new Error(`invalid handler: ${JSON.stringify(handler)}`);
		return [`Cannot run handler: ${err.message}`, err];
	}

	// Models kubernetes/pkg/kubelet/lifecycle/handlers.go handlerRunner.runSleepHandler.
	private async runSleepHandler(ctx: context.Context, seconds: number): Promise<Error | undefined> {
		const selected = await select()
			.case(ctx.done(), () => "done")
			.case(time.after(this.clock, seconds * 1000), () => "timeout");
		if (selected === "done") {
			return new Error("container terminated before sleep hook finished");
		}
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/lifecycle/handlers.go handlerRunner.runHTTPHandler.
	private async runHTTPHandler(
		ctx: context.Context,
		pod: V1Pod,
		container: V1Container,
		handler: V1LifecycleHandler,
		_eventRecorder: EventRecorder,
	): Promise<Error | undefined> {
		const httpGet = handler.httpGet;
		if (!httpGet) {
			return new Error(`invalid HTTP lifecycle handler: ${JSON.stringify(handler)}`);
		}
		let host = httpGet.host ?? "";
		if (host.length === 0) {
			const [runtimePod, podErr] = await this.containerManager.getPod(ctx, pod.metadata?.uid ?? "");
			if (podErr) {
				return new Error(`unable to get pod, event handlers may be invalid: ${podErr.message}`);
			}
			if (!runtimePod) {
				return new Error("unable to get pod, event handlers may be invalid: pod not found");
			}
			const [status, statusErr] = await this.containerManager.getPodStatus(ctx, runtimePod);
			if (statusErr) {
				return new Error(
					`unable to get pod status, event handlers may be invalid: ${statusErr.message}`,
				);
			}
			if (!status || status.ips.length === 0) {
				return new Error(`failed to find networking container: ${JSON.stringify(status)}`);
			}
			host = status.ips[0] ?? "";
		}
		const [port, portErr] = resolveContainerPort(httpGet.port, container);
		if (portErr) {
			return portErr;
		}
		const path = httpGet.path ?? "/";
		const scheme = (httpGet.scheme ?? "HTTP").toLowerCase();
		if (scheme !== "http") {
			return new Error(`unsupported lifecycle hook scheme ${httpGet.scheme}`);
		}
		const headers = Object.fromEntries(
			(httpGet.httpHeaders ?? []).map((header) => [header.name, header.value]),
		);
		try {
			const response = await this.network.fetch(`http://${host}:${port}${path}`, { headers });
			if (response.status < 200 || response.status >= 400) {
				return new Error(`HTTP probe failed with statuscode: ${response.status}`);
			}
			return undefined;
		} catch (error) {
			return error instanceof Error ? error : new Error(String(error));
		}
	}
}
