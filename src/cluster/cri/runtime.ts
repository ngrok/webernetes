import type { Clock } from "../../clock";
import { getClock } from "../../clock-context";
import { Channel, ReadOnlyChannel, select } from "../../go/channel";
import * as context from "../../go/context";
import * as time from "../../go/time";
import type { KubeConfig } from "../../client/config";
import { AppsV1Api, CoreV1Api, DiscoveryV1Api, type KubeClient } from "../../client";
import { newCommandTimedOutError } from "../cri-client/pkg";
import type { DnsHandler, DnsListener } from "../cni/dns";
import * as http from "../cni/http";
import { ClusterNetwork, type NetworkRegistration } from "../cni/network";
import { parseContainerID } from "../kubelet/container/runtime";
import type { ImageDefinition } from "./image";
import { ImageRegistry } from "./image";
import type { ImageManagerService, RuntimeService, ServiceError } from "./apis/services";
import type {
	Container,
	ContainerConfig,
	ContainerFilter,
	ContainerPort,
	CheckpointContainerRequest,
	ContainerStatus,
	ContainerStatusResponse,
	ExecSyncResponse,
	Image,
	ImageFilter,
	ImageFsInfoResponse,
	ImageSpec,
	ImageStatusResponse,
	MetricDescriptor,
	PodSandbox,
	PodSandboxConfig,
	PodSandboxFilter,
	PodSandboxMetrics,
	PodSandboxState,
	PodSandboxStatus,
	PodSandboxStatusResponse,
	StatusResponse,
	UpdateRuntimeConfigRequest,
	VersionResponse,
} from "./runtime/v1/api";

function rawContainerID(id: string): string {
	const parsed = parseContainerID(id);
	return parsed.isEmpty() ? id.replace(/^"+|"+$/g, "") : parsed.id;
}

function errorFromUnknown(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export interface ExecOptions {
	timeoutMs?: number;
}

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface RuntimeOptions {
	ctx: context.Context;
	kubeConfig: KubeConfig;
	network: ClusterNetwork;
	podCIDR: string;
	imageRegistry: ImageRegistry;
	idPrefix?: string;
}

export interface RuntimeDiagnostics {
	sandboxCount(): number;
	containerCount(): number;
	processCount(): number;
	processListenerCount(): number;
}

class ProcessExit extends Error {
	constructor(readonly code: number) {
		super(`process exited with code ${code}`);
	}
}

function isMissingExecutable(cmd: readonly string[], exitCode: number, stderr: string): boolean {
	const command = cmd[0];
	return command !== undefined && exitCode === 127 && stderr === `${command}: not found\n`;
}

function missingExecutableError(containerId: string, command: string): Error {
	return new Error(
		`rpc error: code = Unknown desc = failed to exec in container: failed to start exec in container ${containerId}: OCI runtime exec failed: exec failed: unable to start container process: exec: "${command}": executable file not found in $PATH`,
	);
}

function containerHash(config: ContainerConfig): number {
	const value = config.annotations?.["io.kubernetes.container.hash"];
	if (value === undefined) {
		return 0;
	}
	const parsed = Number.parseInt(value, 16);
	return Number.isFinite(parsed) ? parsed : 0;
}

export type ProcessState = "Created" | "Running" | "Exited";

export class InProcessRuntimeService
	implements RuntimeService, ImageManagerService, RuntimeDiagnostics
{
	readonly clock: Clock;
	readonly kubeConfig: KubeConfig;
	readonly network: ClusterNetwork;
	readonly imageRegistry: ImageRegistry;
	private readonly podCIDR: string;
	private readonly idPrefix: string;
	private readonly sandboxes = new Map<string, PodSandboxInstance>();
	private readonly containers = new Map<string, ContainerInstance>();
	private readonly processes = new Map<number, ProcessInstance>();
	private readonly ctx: context.Context;
	private readonly cancelContext: context.CancelFunc;
	private nextSandboxId = 1;
	private nextContainerId = 1;
	private nextPid = 1;

	constructor(options: RuntimeOptions) {
		this.clock = getClock(options.ctx);
		this.kubeConfig = options.kubeConfig;
		this.network = options.network;
		this.imageRegistry = options.imageRegistry;
		this.podCIDR = options.podCIDR;
		this.idPrefix = options.idPrefix ?? "";
		[this.ctx, this.cancelContext] = context.withCancel(options.ctx);
	}

	// --------------------------------------------------------------------------
	// RuntimeVersioner
	// --------------------------------------------------------------------------
	async version(
		_ctx: context.Context,
		apiVersion: string,
	): Promise<[response: VersionResponse, err: ServiceError]> {
		return [
			{
				version: apiVersion,
				runtimeName: "simulator",
				runtimeVersion: "0.0.0",
				runtimeApiVersion: apiVersion,
			},
			undefined,
		];
	}

	// --------------------------------------------------------------------------
	// PodSandboxManager
	// --------------------------------------------------------------------------
	async runPodSandbox(
		_ctx: context.Context,
		config: PodSandboxConfig,
		_runtimeHandler?: string,
	): Promise<[podSandboxId: string, err: ServiceError]> {
		try {
			const sandbox = new PodSandboxInstance(
				`${this.idPrefix}sandbox-${this.nextSandboxId++}`,
				config,
				this.clock.nowMs(),
			);
			sandbox.setNetworkRegistration(this.network.setupPodSandbox(sandbox, this.podCIDR));
			this.sandboxes.set(sandbox.id, sandbox);
			return [sandbox.id, undefined];
		} catch (error) {
			return ["", errorFromUnknown(error)];
		}
	}

	async stopPodSandbox(_ctx: context.Context, podSandboxId: string): Promise<ServiceError> {
		const sandbox = this.sandboxes.get(rawContainerID(podSandboxId));
		if (!sandbox) {
			return undefined;
		}
		try {
			for (const container of sandbox.containers.values()) {
				await container.stop();
			}
			sandbox.unregisterNetwork();
			return undefined;
		} catch (error) {
			return errorFromUnknown(error);
		}
	}

	async removePodSandbox(ctx: context.Context, podSandboxId: string): Promise<ServiceError> {
		const rawPodSandboxId = rawContainerID(podSandboxId);
		const sandbox = this.sandboxes.get(rawPodSandboxId);
		if (!sandbox) {
			return undefined;
		}
		const stopErr = await this.stopPodSandbox(ctx, rawPodSandboxId);
		if (stopErr) {
			return stopErr;
		}
		for (const container of [...sandbox.containers.values()]) {
			const removeErr = await this.removeContainer(ctx, container.id);
			if (removeErr) {
				return removeErr;
			}
		}
		this.sandboxes.delete(rawPodSandboxId);
		return undefined;
	}

	async podSandboxStatus(
		_ctx: context.Context,
		podSandboxId: string,
		_verbose?: boolean,
	): Promise<[response: PodSandboxStatusResponse | undefined, err: ServiceError]> {
		const [sandbox, err] = this.sandbox(podSandboxId);
		if (err || !sandbox) {
			return [undefined, err];
		}
		return [
			{
				status: sandbox.status(),
				containersStatuses: [...sandbox.containers.values()].map((container) => container.status()),
				timestamp: this.clock.nowMs(),
			},
			undefined,
		];
	}

	async listPodSandbox(
		_ctx: context.Context,
		filter?: PodSandboxFilter,
	): Promise<[items: PodSandbox[], err: ServiceError]> {
		return [
			[...this.sandboxes.values()]
				.filter((sandbox) => this.matchesPodSandboxFilter(sandbox, filter))
				.map((sandbox) => this.toPodSandbox(sandbox)),
			undefined,
		];
	}

	// --------------------------------------------------------------------------
	// Local lifecycle
	// --------------------------------------------------------------------------
	async close(): Promise<void> {
		this.cancelContext();
		for (const sandbox of [...this.sandboxes.values()]) {
			const err = await this.removePodSandbox(this.ctx, sandbox.id);
			if (err) {
				throw err;
			}
		}
		for (const process of [...this.processes.values()]) {
			await process.kill("SIGKILL");
		}
	}

	// --------------------------------------------------------------------------
	// RuntimeDiagnostics
	// --------------------------------------------------------------------------
	sandboxCount(): number {
		return this.sandboxes.size;
	}

	containerCount(): number {
		return this.containers.size;
	}

	processCount(): number {
		return this.processes.size;
	}

	processListenerCount(): number {
		return [...this.processes.values()].reduce(
			(total, process) => total + process.listenerCount(),
			0,
		);
	}

	// --------------------------------------------------------------------------
	// ContainerManager
	// --------------------------------------------------------------------------
	async createContainer(
		_ctx: context.Context,
		podSandboxId: string,
		config: ContainerConfig,
		sandboxConfig: PodSandboxConfig,
	): Promise<[containerId: string, err: ServiceError]> {
		const [sandbox, sandboxErr] = this.sandbox(podSandboxId);
		if (sandboxErr || !sandbox) {
			return ["", sandboxErr];
		}
		if (sandbox.uid !== sandboxConfig.metadata.uid) {
			return [
				"",
				new Error(`sandbox config uid ${sandboxConfig.metadata.uid} does not match ${sandbox.uid}`),
			];
		}
		if (!this.imageRegistry.has(config.image.image)) {
			return ["", new Error(`image ${config.image.image} not found`)];
		}
		const container = new ContainerInstance(
			`${this.idPrefix}container-${this.nextContainerId++}`,
			sandbox,
			config,
			() => this.imageRegistry.create(config.image.image),
			this,
		);
		sandbox.containers.set(container.id, container);
		this.containers.set(container.id, container);
		return [container.id, undefined];
	}

	async startContainer(_ctx: context.Context, containerId: string): Promise<ServiceError> {
		const [container, err] = this.container(containerId);
		if (err || !container) {
			return err;
		}
		try {
			container.start();
			return undefined;
		} catch (error) {
			return errorFromUnknown(error);
		}
	}

	async stopContainer(
		_ctx: context.Context,
		containerId: string,
		timeout?: number,
	): Promise<ServiceError> {
		const [container, err] = this.container(rawContainerID(containerId));
		if (err || !container) {
			return err;
		}
		try {
			await container.stop(timeout ?? 0);
			return undefined;
		} catch (error) {
			return errorFromUnknown(error);
		}
	}

	async removeContainer(_ctx: context.Context, containerId: string): Promise<ServiceError> {
		const rawId = rawContainerID(containerId);
		const container = this.containers.get(rawId);
		if (!container) {
			return undefined;
		}
		try {
			await container.stop();
			container.sandbox.containers.delete(container.id);
			this.containers.delete(rawId);
			return undefined;
		} catch (error) {
			return errorFromUnknown(error);
		}
	}

	async listContainers(
		_ctx: context.Context,
		filter?: ContainerFilter,
	): Promise<[containers: Container[], err: ServiceError]> {
		return [
			[...this.containers.values()]
				.filter((container) => this.matchesContainerFilter(container, filter))
				.map((container) => this.toCRIContainer(container)),
			undefined,
		];
	}

	async containerStatus(
		_ctx: context.Context,
		containerId: string,
		_verbose?: boolean,
	): Promise<[response: ContainerStatusResponse | undefined, err: ServiceError]> {
		const [container, err] = this.container(rawContainerID(containerId));
		if (err || !container) {
			return [undefined, err];
		}
		return [{ status: container.status() }, undefined];
	}

	async execSync(
		ctx: context.Context,
		containerId: string,
		cmd: string[],
		timeoutSeconds?: number,
	): Promise<[response: ExecSyncResponse | undefined, err: ServiceError]> {
		const [container, err] = this.container(containerId);
		if (err || !container) {
			return [undefined, err];
		}
		const timeoutMs = timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000;
		try {
			const process = container.exec(cmd, { timeoutMs });
			const exitCode = await this.waitForProcess(ctx, process, timeoutMs, cmd);
			if (isMissingExecutable(cmd, exitCode, process.stderr)) {
				return [undefined, missingExecutableError(containerId, cmd[0] ?? "")];
			}
			return [{ exitCode, stdout: process.stdout, stderr: process.stderr }, undefined];
		} catch (error) {
			return [undefined, errorFromUnknown(error)];
		}
	}

	async checkpointContainer(
		_ctx: context.Context,
		_options: CheckpointContainerRequest,
	): Promise<ServiceError> {
		return new Error("checkpointContainer is not supported");
	}

	// --------------------------------------------------------------------------
	// ImageManagerService
	// --------------------------------------------------------------------------
	async pullImage(
		_ctx: context.Context,
		image: ImageSpec,
		_credentials: unknown[],
		_podSandboxConfig?: PodSandboxConfig,
	): Promise<[imageRef: string, err: Error | undefined]> {
		if (!this.imageRegistry.has(image.image)) {
			return [
				"",
				new Error(
					`rpc error: code = NotFound desc = failed to pull and unpack image "${image.image}": failed to resolve reference "${image.image}": ${image.image}: not found`,
				),
			];
		}
		// TODO(samwho): inject latency here to simulate real pulling.
		return [image.image, undefined];
	}

	async imageStatus(
		_ctx: context.Context,
		image: ImageSpec,
		_verbose?: boolean,
	): Promise<[response: ImageStatusResponse | undefined, err: ServiceError]> {
		if (!this.imageRegistry.has(image.image)) {
			return [{ image: undefined }, undefined];
		}
		return [
			{
				image: this.toRuntimeAPIImage(image),
			},
			undefined,
		];
	}

	async listImages(
		_ctx: context.Context,
		filter?: ImageFilter,
	): Promise<[images: Image[], err: ServiceError]> {
		const images: Image[] = [];
		for (const image of this.imageRegistry.list()) {
			if (filter?.image?.image !== undefined && filter.image.image !== image) {
				continue;
			}
			images.push(this.toRuntimeAPIImage({ image }));
		}
		return [images, undefined];
	}

	async removeImage(_ctx: context.Context, image: ImageSpec): Promise<ServiceError> {
		// Kubernetes expects removing an image that is not local to be a no-op.
		this.imageRegistry.remove(image.image);
		return undefined;
	}

	async imageFsInfo(
		_ctx: context.Context,
	): Promise<[response: ImageFsInfoResponse, err: ServiceError]> {
		return [{ imageFilesystems: [], containerFilesystems: [] }, undefined];
	}

	// --------------------------------------------------------------------------
	// RuntimeService
	// --------------------------------------------------------------------------
	async status(
		_ctx: context.Context,
		_verbose?: boolean,
	): Promise<[response: StatusResponse, err: ServiceError]> {
		return [
			{
				status: {
					conditions: [
						{ type: "RuntimeReady", status: true },
						{ type: "NetworkReady", status: true },
					],
				},
			},
			undefined,
		];
	}

	async updateRuntimeConfig(
		_ctx: context.Context,
		_config: UpdateRuntimeConfigRequest,
	): Promise<ServiceError> {
		return new Error("updateRuntimeConfig is not supported");
	}

	async listMetricDescriptors(
		_ctx: context.Context,
	): Promise<[descriptors: MetricDescriptor[], err: ServiceError]> {
		return [[], new Error("listMetricDescriptors is not supported")];
	}

	async listPodSandboxMetrics(
		_ctx: context.Context,
	): Promise<[metrics: PodSandboxMetrics[], err: ServiceError]> {
		return [[], new Error("listPodSandboxMetrics is not supported")];
	}

	createProcess(
		container: ContainerInstance,
		argv: readonly string[],
		run: (context: ProcessContext, argv: readonly string[]) => Promise<number>,
	): ProcessInstance {
		const process = new ProcessInstance(this.ctx, this.nextPid++, container, argv, run, this);
		this.processes.set(process.pid, process);
		void process.wait().finally(() => {
			this.processes.delete(process.pid);
		});
		return process;
	}

	async sleep(ctx: context.Context, ms: number, exitCode: () => number): Promise<void> {
		if (ctx.err()) {
			return Promise.reject(new ProcessExit(exitCode()));
		}
		const selected = await select()
			.case(ctx.done(), () => "done")
			.case(time.after(ctx, ms), () => "timeout");
		if (selected === "done") {
			throw new ProcessExit(exitCode());
		}
	}

	// --------------------------------------------------------------------------
	// Private helpers
	// --------------------------------------------------------------------------
	private async waitForProcess(
		ctx: context.Context,
		process: ProcessInstance,
		timeoutMs: number | undefined,
		cmd: readonly string[],
	): Promise<number> {
		const waitCh = new Channel<number>(1);
		void process.wait().then((code) => {
			waitCh.trySend(code);
			return undefined;
		});

		if (timeoutMs === undefined) {
			const selected = await select()
				.case(waitCh, ({ value }) => ({ type: "exit" as const, code: value ?? 0 }))
				.case(ctx.done(), () => ({ type: "canceled" as const }));
			if (selected.type === "exit") {
				return selected.code;
			}
			await process.kill("SIGKILL");
			return process.abortExitCode;
		}

		let timeoutHandle: number | undefined;
		const timeoutCh = new Channel<void>(1);
		timeoutHandle = this.clock.setTimeout(() => {
			timeoutCh.trySend(undefined);
		}, timeoutMs);
		try {
			const selected = await select()
				.case(waitCh, ({ value }) => ({ type: "exit" as const, code: value ?? 0 }))
				.case(ctx.done(), () => ({ type: "canceled" as const }))
				.case(timeoutCh, () => ({ type: "timeout" as const }));
			if (selected.type === "exit") {
				return selected.code;
			}
			await process.kill("SIGKILL");
			if (selected.type === "timeout") {
				throw newCommandTimedOutError(cmd);
			}
			return process.abortExitCode;
		} finally {
			if (timeoutHandle !== undefined) {
				this.clock.clearTimeout(timeoutHandle);
			}
		}
	}

	private sandbox(
		podSandboxId: string,
	): [sandbox: PodSandboxInstance | undefined, err: ServiceError] {
		const rawId = rawContainerID(podSandboxId);
		const sandbox = this.sandboxes.get(rawId);
		if (!sandbox) {
			return [undefined, new Error(`pod sandbox ${podSandboxId} not found`)];
		}
		return [sandbox, undefined];
	}

	private container(
		containerId: string,
	): [container: ContainerInstance | undefined, err: ServiceError] {
		const rawId = rawContainerID(containerId);
		const container = this.containers.get(rawId);
		if (!container) {
			return [undefined, new Error(`container ${containerId} not found`)];
		}
		return [container, undefined];
	}

	private toRuntimeAPIImage(image: ImageSpec): Image {
		return {
			id: image.image,
			repoTags: [image.image],
			repoDigests: [],
			size: 0,
			spec: image,
			pinned: false,
		};
	}

	private toPodSandbox(sandbox: PodSandboxInstance): PodSandbox {
		const status = sandbox.status();
		return {
			id: status.id,
			metadata: { ...status.metadata },
			state: status.state,
			createdAt: status.createdAt,
			labels: { ...status.labels },
			annotations: { ...status.annotations },
		};
	}

	private toCRIContainer(container: ContainerInstance): Container {
		const status = container.status();
		return {
			id: status.id,
			podSandboxId: container.sandbox.id,
			metadata: { ...container.config.metadata },
			image: { ...container.config.image },
			imageRef: status.imageRef,
			state: status.state,
			createdAt: status.createdAt,
			labels: { ...(container.config.labels ?? {}) },
			annotations: { ...(container.config.annotations ?? {}) },
			imageId: status.imageRef,
		};
	}

	private matchesPodSandboxFilter(
		sandbox: PodSandboxInstance,
		filter: PodSandboxFilter | undefined,
	): boolean {
		if (!filter) {
			return true;
		}
		if (filter.id !== undefined && rawContainerID(filter.id) !== sandbox.id) {
			return false;
		}
		if (filter.state !== undefined && filter.state.state !== sandbox.status().state) {
			return false;
		}
		return this.matchesLabels(sandbox.status().labels, filter.labelSelector);
	}

	private matchesContainerFilter(
		container: ContainerInstance,
		filter: ContainerFilter | undefined,
	): boolean {
		if (!filter) {
			return true;
		}
		if (filter.id !== undefined && rawContainerID(filter.id) !== container.id) {
			return false;
		}
		if (
			filter.podSandboxId !== undefined &&
			rawContainerID(filter.podSandboxId) !== container.sandbox.id
		) {
			return false;
		}
		if (filter.state !== undefined && filter.state.state !== container.status().state) {
			return false;
		}
		return this.matchesLabels(container.config.labels ?? {}, filter.labelSelector);
	}

	private matchesLabels(
		labels: Record<string, string>,
		selector: Record<string, string> | undefined,
	): boolean {
		return Object.entries(selector ?? {}).every(([key, value]) => labels[key] === value);
	}
}

export class PodSandboxInstance {
	readonly labels: ReadonlyMap<string, string>;
	readonly annotations: ReadonlyMap<string, string>;
	readonly containers = new Map<string, ContainerInstance>();
	private registration: NetworkRegistration | undefined;
	private state: PodSandboxState = "NotReady";

	constructor(
		readonly id: string,
		readonly config: PodSandboxConfig,
		readonly createdAt: number,
	) {
		this.uid = config.metadata.uid;
		this.name = config.metadata.name;
		this.namespace = config.metadata.namespace;
		this.attempt = config.metadata.attempt;
		this.labels = new Map(Object.entries(config.labels ?? {}));
		this.annotations = new Map(Object.entries(config.annotations ?? {}));
	}

	readonly uid: string;
	readonly name: string;
	readonly namespace: string;
	readonly attempt: number;

	get ip(): string {
		return this.networkRegistration().ip;
	}

	setNetworkRegistration(registration: NetworkRegistration): void {
		this.registration = registration;
		this.state = "Ready";
	}

	networkRegistration(): NetworkRegistration {
		if (!this.registration) {
			throw new Error(`pod ${this.uid} is not registered on the network`);
		}
		return this.registration;
	}

	unregisterNetwork(): void {
		this.registration?.unregister();
		this.registration = undefined;
		this.state = "NotReady";
	}

	status(): PodSandboxStatus {
		const network = this.registration ? { ip: this.registration.ip } : undefined;
		return {
			id: this.id,
			metadata: this.config.metadata,
			state: this.state,
			createdAt: this.createdAt,
			network,
			labels: Object.fromEntries(this.labels),
			annotations: Object.fromEntries(this.annotations),
		};
	}
}

export class ContainerInstance {
	readonly command: readonly string[];
	readonly args: readonly string[];
	readonly env: ReadonlyMap<string, string>;
	readonly ports: readonly ContainerPort[];
	readonly restartCount: number;
	readonly createdAt: number;
	readonly fs = new ContainerFileSystem();
	private readonly image: ImageDefinition;
	private state: ContainerStatus["state"] = "Created";
	private mainProcess: ProcessInstance | undefined;
	private startedAtMs: number | undefined;
	private finishedAtMs: number | undefined;
	private lastExitCode: number | undefined;

	constructor(
		readonly id: string,
		readonly sandbox: PodSandboxInstance,
		readonly config: ContainerConfig,
		private readonly imageFactory: () => ImageDefinition | undefined,
		private readonly runtime: InProcessRuntimeService,
	) {
		this.name = config.metadata.name;
		this.restartCount = config.metadata.attempt;
		this.imageRef = config.image.image;
		this.command = config.command ?? [];
		this.args = config.args ?? [];
		this.env = new Map(Object.entries(config.env ?? {}));
		this.ports = config.ports ?? [];
		this.createdAt = runtime.clock.nowMs();
		this.image = this.createImage();
	}

	readonly name: string;
	readonly imageRef: string;

	start(): ProcessInstance {
		if (this.state === "Running") {
			throw new Error(`container ${this.id} is already running`);
		}
		const argv = this.startArgv();
		const process = this.runtime.createProcess(this, argv, this.image.exec.bind(this.image));
		this.state = "Running";
		this.startedAtMs = this.runtime.clock.nowMs();
		this.finishedAtMs = undefined;
		this.lastExitCode = undefined;
		this.mainProcess = process;
		void process.wait().then((exitCode) => {
			if (this.mainProcess !== process) {
				return undefined;
			}
			this.state = "Exited";
			this.finishedAtMs = process.finishedAt;
			this.lastExitCode = exitCode;
			return undefined;
		});
		process.start();
		return process;
	}

	exec(argv: string[], _options: ExecOptions = {}): ProcessInstance {
		const process = this.runtime.createProcess(this, argv, this.image.exec.bind(this.image));
		process.start();
		return process;
	}

	async stop(timeoutSeconds = 0): Promise<void> {
		if (this.mainProcess && this.mainProcess.state !== "Exited") {
			await this.mainProcess.kill(
				timeoutSeconds === 0 ? "SIGKILL" : (this.config.stopSignal ?? "SIGTERM"),
			);
		}
		this.state = "Exited";
		this.finishedAtMs = this.runtime.clock.nowMs();
	}

	status(): ContainerStatus {
		return {
			id: this.id,
			name: this.name,
			image: { ...this.config.image },
			imageRef: this.imageRef,
			imageId: this.imageRef,
			imageRuntimeHandler: "",
			hash: containerHash(this.config),
			state: this.state,
			restartCount: this.restartCount,
			createdAt: this.createdAt,
			startedAt: this.startedAtMs,
			finishedAt: this.finishedAtMs,
			exitCode: this.lastExitCode,
			labels: { ...(this.config.labels ?? {}) },
			annotations: { ...(this.config.annotations ?? {}) },
			ready: this.state === "Running",
		};
	}

	private createImage(): ImageDefinition {
		const image = this.imageFactory();
		if (!image) {
			throw new Error(`image ${this.imageRef} not found`);
		}
		return image;
	}

	private startArgv(): readonly string[] {
		const command = this.command.length > 0 ? this.command : (this.image.defaultCommand ?? []);
		return [...command, ...this.args];
	}
}

export class ProcessInstance {
	private processState: ProcessState = "Created";
	private finishedAtMs: number | undefined;
	private processExitCode: number | undefined;
	private killedExitCode: number | undefined;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	readonly ctx: context.Context;
	private readonly cancelContext: context.CancelFunc;
	private readonly listeners: Array<{ close(): void }> = [];
	private resolveWait: (code: number) => void = () => {};
	private readonly waitPromise = new Promise<number>((resolve) => {
		this.resolveWait = resolve;
	});

	constructor(
		ctx: context.Context,
		readonly pid: number,
		readonly container: ContainerInstance,
		readonly argv: readonly string[],
		private readonly run: (context: ProcessContext, argv: readonly string[]) => Promise<number>,
		private readonly runtime: InProcessRuntimeService,
	) {
		this.startedAt = runtime.clock.nowMs();
		[this.ctx, this.cancelContext] = context.withCancel(ctx);
	}

	readonly startedAt: number;

	get state(): ProcessState {
		return this.processState;
	}

	get finishedAt(): number | undefined {
		return this.finishedAtMs;
	}

	get exitCode(): number | undefined {
		return this.processExitCode;
	}

	get abortExitCode(): number {
		return this.killedExitCode ?? this.processExitCode ?? 143;
	}

	get stdout(): string {
		return this.stdoutBuffer;
	}

	get stderr(): string {
		return this.stderrBuffer;
	}

	start(): void {
		if (this.processState !== "Created") {
			throw new Error(`process ${this.pid} was already started`);
		}
		this.processState = "Running";
		const context = new ProcessContext(this, this.runtime);
		void this.run(context, this.argv)
			.then((code) => this.finish(code))
			.catch((error: unknown) => {
				if (error instanceof ProcessExit) {
					this.finish(error.code);
					return;
				}
				this.finish(1);
			});
	}

	wait(): Promise<number> {
		return this.waitPromise;
	}

	async kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
		const exitCode = signal === "SIGKILL" ? 137 : 143;
		this.killedExitCode = exitCode;
		this.cancelContext();
		this.finish(exitCode);
	}

	trackListener(listener: { close(): void }): void {
		this.listeners.push(listener);
	}

	listenerCount(): number {
		return this.listeners.length;
	}

	writeStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
	}

	writeStderr(chunk: string): void {
		this.stderrBuffer += chunk;
	}

	async waitUntilKilled(): Promise<number> {
		if (this.ctx.err()) {
			return Promise.resolve(this.killedExitCode ?? this.processExitCode ?? 143);
		}
		await this.ctx.done().receive();
		return this.killedExitCode ?? this.processExitCode ?? 143;
	}

	exit(code: number): never {
		this.cancelContext();
		this.finish(code);
		throw new ProcessExit(code);
	}

	private finish(code: number): void {
		if (this.processState === "Exited") {
			return;
		}
		this.processState = "Exited";
		this.finishedAtMs = this.runtime.clock.nowMs();
		this.processExitCode = code;
		this.cancelContext();
		for (const listener of this.listeners.splice(0)) {
			listener.close();
		}
		this.resolveWait(code);
	}
}

export class ProcessContext implements context.Context {
	readonly pid: number;
	readonly argv: readonly string[];
	readonly env: ReadonlyMap<string, string>;
	readonly container: ContainerInstance;
	readonly pod: PodSandboxInstance;
	readonly fs: ContainerFileSystem;
	readonly kubeConfig: KubeConfig;
	readonly api: KubeClient;
	readonly clock: Clock;
	/**
	 * Internal simulator network access for cluster components such as kube-proxy.
	 * User images generally should not mutate this directly.
	 */
	readonly network: ClusterNetwork;

	constructor(
		private readonly process: ProcessInstance,
		private readonly runtime: InProcessRuntimeService,
	) {
		this.pid = process.pid;
		this.argv = process.argv;
		this.env = process.container.env;
		this.container = process.container;
		this.pod = process.container.sandbox;
		this.fs = process.container.fs;
		this.kubeConfig = runtime.kubeConfig;
		this.api = {
			appsv1: runtime.kubeConfig.makeApiClient(AppsV1Api),
			corev1: runtime.kubeConfig.makeApiClient(CoreV1Api),
			discoveryv1: runtime.kubeConfig.makeApiClient(DiscoveryV1Api),
		};
		this.clock = runtime.clock;
		this.network = runtime.network;
	}

	done(): ReadOnlyChannel<void> {
		return this.process.ctx.done();
	}

	err(): context.ContextError | undefined {
		return this.process.ctx.err();
	}

	value(key: unknown): unknown {
		return this.process.ctx.value(key);
	}

	exec(argv: string[], options?: ExecOptions): ProcessInstance {
		return this.process.container.exec(argv, options);
	}

	writeStdout(chunk: string): void {
		this.process.writeStdout(chunk);
	}

	writeStderr(chunk: string): void {
		this.process.writeStderr(chunk);
	}

	listenHttp(port: number, handler: http.Handler): http.Listener {
		const listener = this.pod.networkRegistration().bindHttp(port, handler);
		this.process.trackListener(listener);
		return listener;
	}

	listenDns(port: number, handler: DnsHandler): DnsListener {
		const listener = this.pod.networkRegistration().bindDns(port, handler);
		this.process.trackListener(listener);
		return listener;
	}

	async fetch(target: http.FetchInput, init?: http.FetchInit): Promise<http.Response> {
		if (!this.pod.config.pod) {
			throw new Error(`pod origin is not registered for sandbox ${this.pod.id}`);
		}
		return await this.runtime.network.fetch(
			this.process.ctx,
			this.pod.config.pod,
			target,
			init ?? {},
		);
	}

	sleep(ms: number): Promise<void> {
		return this.runtime.sleep(this.process.ctx, ms, () => this.process.abortExitCode);
	}

	waitUntilKilled(): Promise<number> {
		return this.process.waitUntilKilled();
	}

	exit(code = 0): never {
		return this.process.exit(code);
	}
}

export class ContainerFileSystem {
	private readonly files = new Map<string, string>();

	read(path: string): string | undefined {
		return this.files.get(path);
	}

	write(path: string, contents = ""): void {
		this.files.set(path, contents);
	}

	delete(path: string): boolean {
		return this.files.delete(path);
	}

	has(path: string): boolean {
		return this.files.has(path);
	}
}
