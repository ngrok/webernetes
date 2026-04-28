import type { Clock } from "../../clock";
import type { KubeConfig } from "../../client/types";
import type { DnsHandler, DnsListener, DnsRecordType, DnsResponse } from "../cni/dns";
import type { HttpHandler, HttpListener, HttpRequest, HttpResponse } from "../cni/http";
import { ClusterNetwork, type NetworkRegistration } from "../cni/network";
import type { ImageDefinition } from "./image";
import { ImageRegistry } from "./image";

export interface PodSandboxMetadata {
	uid: string;
	name: string;
	namespace: string;
	attempt: number;
}

export interface DnsConfig {
	servers: string[];
	searches: string[];
	options: string[];
}

export interface PortMapping {
	protocol?: "TCP" | "UDP" | "SCTP";
	containerPort: number;
	hostPort?: number;
	hostIp?: string;
}

export interface PodSandboxConfig {
	metadata: PodSandboxMetadata;
	hostname?: string;
	logDirectory?: string;
	dnsConfig?: DnsConfig;
	portMappings?: PortMapping[];
	labels?: Record<string, string>;
	annotations?: Record<string, string>;
}

export interface ImageSpec {
	image: string;
	annotations?: Record<string, string>;
}

export interface ContainerMetadata {
	name: string;
	attempt: number;
}

export interface ContainerConfig {
	metadata: ContainerMetadata;
	image: ImageSpec;
	command?: string[];
	args?: string[];
	env?: Record<string, string>;
	ports?: ContainerPort[];
	labels?: Record<string, string>;
	annotations?: Record<string, string>;
	stopSignal?: "SIGTERM" | "SIGKILL";
}

export interface ContainerPort {
	name?: string;
	containerPort: number;
	protocol?: "TCP" | "UDP" | "SCTP";
}

export interface ExecOptions {
	timeoutMs?: number;
}

export interface ExecResult {
	exitCode: number;
}

export interface RuntimeOptions {
	clock: Clock;
	kubeConfig: KubeConfig;
	network: ClusterNetwork;
	imageRegistry: ImageRegistry;
}

class ProcessExit extends Error {
	constructor(readonly code: number) {
		super(`process exited with code ${code}`);
	}
}

function dnsLookupCandidates(
	name: string,
	searches: readonly string[] = [],
	options: readonly string[] = [],
): string[] {
	const trimmedName = name.trim();
	if (trimmedName.endsWith(".")) {
		return [trimmedName.slice(0, -1)];
	}

	const ndots = dnsNdots(options);
	const absoluteFirst = dotCount(trimmedName) >= ndots;
	const searched = searches.map((search) => `${trimmedName}.${search.replace(/\.$/, "")}`);
	return uniqueStrings(absoluteFirst ? [trimmedName, ...searched] : [...searched, trimmedName]);
}

function dnsNdots(options: readonly string[]): number {
	for (const option of options) {
		const match = /^ndots:(\d+)$/.exec(option);
		if (match) {
			return Number(match[1]);
		}
	}
	return 1;
}

function dotCount(value: string): number {
	return [...value].filter((character) => character === ".").length;
}

function uniqueStrings(values: readonly string[]): string[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		if (seen.has(value)) {
			return false;
		}
		seen.add(value);
		return true;
	});
}

export type ContainerState = "Created" | "Running" | "Exited";
export type PodSandboxState = "Ready" | "NotReady";
export type ProcessState = "Created" | "Running" | "Exited";

export interface PodSandboxStatus {
	id: string;
	metadata: PodSandboxMetadata;
	state: PodSandboxState;
	createdAt: number;
	network?: {
		ip: string;
	};
	labels: Record<string, string>;
	annotations: Record<string, string>;
}

export interface ContainerStatus {
	id: string;
	name: string;
	imageRef: string;
	state: ContainerState;
	restartCount: number;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	exitCode?: number;
	reason?: string;
	message?: string;
	ready: boolean;
}

export class Runtime {
	readonly network: ClusterNetwork;
	readonly imageRegistry: ImageRegistry;
	private readonly sandboxes = new Map<string, PodSandboxInstance>();
	private readonly containers = new Map<string, ContainerInstance>();
	private nextSandboxId = 1;
	private nextContainerId = 1;
	private nextPid = 1;

	constructor(private readonly options: RuntimeOptions) {
		this.network = options.network;
		this.imageRegistry = options.imageRegistry;
	}

	async runPodSandbox(config: PodSandboxConfig): Promise<string> {
		const sandbox = new PodSandboxInstance(`sandbox-${this.nextSandboxId++}`, config, this.nowMs());
		sandbox.setNetworkRegistration(this.network.setupPodSandbox(sandbox));
		this.sandboxes.set(sandbox.id, sandbox);
		return sandbox.id;
	}

	async stopPodSandbox(podSandboxId: string): Promise<void> {
		const sandbox = this.sandboxes.get(podSandboxId);
		if (!sandbox) {
			return;
		}
		for (const container of sandbox.containers.values()) {
			await container.stop();
		}
		sandbox.unregisterNetwork();
		sandbox.setReady(false);
	}

	async removePodSandbox(podSandboxId: string): Promise<void> {
		const sandbox = this.sandboxes.get(podSandboxId);
		if (!sandbox) {
			return;
		}
		await this.stopPodSandbox(podSandboxId);
		for (const container of [...sandbox.containers.values()]) {
			await this.removeContainer(container.id);
		}
		this.sandboxes.delete(podSandboxId);
	}

	podSandboxStatus(podSandboxId: string): PodSandboxStatus {
		return this.sandboxOrThrow(podSandboxId).status();
	}

	listPodSandboxes(): PodSandboxInstance[] {
		return [...this.sandboxes.values()];
	}

	getPodSandbox(podSandboxId: string): PodSandboxInstance | undefined {
		return this.sandboxes.get(podSandboxId);
	}

	getPodSandboxesByPodUid(podUid: string): PodSandboxInstance[] {
		return [...this.sandboxes.values()]
			.filter((sandbox) => sandbox.uid === podUid)
			.toSorted(
				(left, right) =>
					right.createdAt - left.createdAt ||
					right.attempt - left.attempt ||
					right.id.localeCompare(left.id),
			);
	}

	async createContainer(
		podSandboxId: string,
		config: ContainerConfig,
		sandboxConfig: PodSandboxConfig,
	): Promise<string> {
		const sandbox = this.sandboxOrThrow(podSandboxId);
		if (sandbox.uid !== sandboxConfig.metadata.uid) {
			throw new Error(
				`sandbox config uid ${sandboxConfig.metadata.uid} does not match ${sandbox.uid}`,
			);
		}
		const image = this.imageRegistry.resolve(config.image.image);
		if (!image) {
			throw new Error(`image ${config.image.image} not found`);
		}
		const container = new ContainerInstance(
			`container-${this.nextContainerId++}`,
			sandbox,
			config,
			image,
			this,
		);
		sandbox.containers.set(container.id, container);
		this.containers.set(container.id, container);
		return container.id;
	}

	async pullImage(image: ImageSpec): Promise<string> {
		if (!this.imageRegistry.resolve(image.image)) {
			throw new Error(`image ${image.image} not found`);
		}
		return image.image;
	}

	imageStatus(image: ImageSpec): ImageSpec | undefined {
		return this.imageRegistry.resolve(image.image) ? image : undefined;
	}

	async startContainer(containerId: string): Promise<void> {
		this.containerOrThrow(containerId).start();
	}

	async stopContainer(containerId: string, timeoutSeconds = 0): Promise<void> {
		await this.containerOrThrow(containerId).stop(timeoutSeconds);
	}

	async removeContainer(containerId: string): Promise<void> {
		const container = this.containers.get(containerId);
		if (!container) {
			return;
		}
		await container.stop();
		container.sandbox.containers.delete(container.id);
		this.containers.delete(containerId);
	}

	getContainer(containerId: string): ContainerInstance | undefined {
		return this.containers.get(containerId);
	}

	containerStatus(containerId: string): ContainerStatus {
		return this.containerOrThrow(containerId).status();
	}

	async execSync(
		containerId: string,
		argv: string[],
		options: ExecOptions = {},
	): Promise<ExecResult> {
		const process = this.containerOrThrow(containerId).exec(argv, options);
		const exitCode = await this.waitForProcess(process, options.timeoutMs);
		return { exitCode };
	}

	createProcess(
		container: ContainerInstance,
		argv: readonly string[],
		run: (context: ProcessContext, argv: readonly string[]) => Promise<number>,
	): ProcessInstance {
		return new ProcessInstance(this.nextPid++, container, argv, run, this);
	}

	sleep(ms: number): Promise<void> {
		return this.options.clock.wait(ms);
	}

	async sleepUntil(signal: AbortSignal, ms: number, exitCode: () => number): Promise<void> {
		if (signal.aborted) {
			return Promise.reject(new ProcessExit(exitCode()));
		}
		let timeoutHandle: number | undefined;
		let removeAbortListener: (() => void) | undefined;
		try {
			return await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					if (timeoutHandle !== undefined) {
						this.options.clock.clearTimeout(timeoutHandle);
						timeoutHandle = undefined;
					}
					reject(new ProcessExit(exitCode()));
				};
				removeAbortListener = () => signal.removeEventListener("abort", onAbort);
				signal.addEventListener("abort", onAbort, { once: true });
				timeoutHandle = this.options.clock.setTimeout(() => {
					timeoutHandle = undefined;
					removeAbortListener?.();
					resolve();
				}, ms);
			});
		} finally {
			if (timeoutHandle !== undefined) {
				this.options.clock.clearTimeout(timeoutHandle);
			}
			removeAbortListener?.();
		}
	}

	nowMs(): number {
		return this.options.clock.nowMs();
	}

	kubeConfig(): KubeConfig {
		return this.options.kubeConfig;
	}

	private async waitForProcess(
		process: ProcessInstance,
		timeoutMs: number | undefined,
	): Promise<number> {
		if (timeoutMs === undefined) {
			return await process.wait();
		}
		let timeoutHandle: number | undefined;
		try {
			return await Promise.race([
				process.wait(),
				new Promise<number>((resolve) => {
					timeoutHandle = this.options.clock.setTimeout(() => resolve(124), timeoutMs);
				}),
			]);
		} finally {
			if (timeoutHandle !== undefined) {
				this.options.clock.clearTimeout(timeoutHandle);
			}
		}
	}

	private sandboxOrThrow(podSandboxId: string): PodSandboxInstance {
		const sandbox = this.sandboxes.get(podSandboxId);
		if (!sandbox) {
			throw new Error(`pod sandbox ${podSandboxId} not found`);
		}
		return sandbox;
	}

	private containerOrThrow(containerId: string): ContainerInstance {
		const container = this.containers.get(containerId);
		if (!container) {
			throw new Error(`container ${containerId} not found`);
		}
		return container;
	}
}

export class PodSandboxInstance {
	readonly labels: ReadonlyMap<string, string>;
	readonly annotations: ReadonlyMap<string, string>;
	readonly containers = new Map<string, ContainerInstance>();
	private ready = false;
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

	isReady(): boolean {
		return this.ready;
	}

	setReady(ready: boolean): void {
		// TODO(probes): derive Pod readiness from container readiness and probe status.
		this.ready = ready;
		this.registration?.updateEndpoints(this);
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

	networkPeer() {
		return {
			namespace: this.namespace,
			podName: this.name,
			podUid: this.uid,
			ip: this.ip,
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
	private state: ContainerState = "Created";
	private mainProcess: ProcessInstance | undefined;
	private startedAtMs: number | undefined;
	private finishedAtMs: number | undefined;
	private lastExitCode: number | undefined;

	constructor(
		readonly id: string,
		readonly sandbox: PodSandboxInstance,
		readonly config: ContainerConfig,
		private readonly image: ImageDefinition,
		private readonly runtime: Runtime,
	) {
		this.name = config.metadata.name;
		this.restartCount = config.metadata.attempt;
		this.imageRef = config.image.image;
		this.command = config.command ?? [];
		this.args = config.args ?? [];
		this.env = new Map(Object.entries(config.env ?? {}));
		this.ports = config.ports ?? [];
		this.createdAt = runtime.nowMs();
	}

	readonly name: string;
	readonly imageRef: string;

	get pod(): PodSandboxInstance {
		return this.sandbox;
	}

	start(): ProcessInstance {
		if (this.state === "Running") {
			throw new Error(`container ${this.id} is already running`);
		}
		const argv = this.startArgv();
		const process = this.runtime.createProcess(this, argv, this.image.start.bind(this.image));
		this.state = "Running";
		this.startedAtMs = this.runtime.nowMs();
		this.finishedAtMs = undefined;
		this.lastExitCode = undefined;
		this.mainProcess = process;
		// TODO(probes): containers without readiness probes become ready after startup for now.
		this.sandbox.setReady(true);
		process.wait().then((exitCode) => {
			if (this.mainProcess !== process) {
				return undefined;
			}
			this.state = "Exited";
			this.finishedAtMs = process.finishedAt;
			this.lastExitCode = exitCode;
			this.sandbox.setReady(false);
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
		this.finishedAtMs = this.runtime.nowMs();
		this.sandbox.setReady(false);
	}

	status(): ContainerStatus {
		return {
			id: this.id,
			name: this.name,
			imageRef: this.imageRef,
			state: this.state,
			restartCount: this.restartCount,
			createdAt: this.createdAt,
			startedAt: this.startedAtMs,
			finishedAt: this.finishedAtMs,
			exitCode: this.lastExitCode,
			ready: this.state === "Running",
		};
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
	private readonly abortController = new AbortController();
	private readonly listeners: Array<{ close(): void }> = [];
	private resolveWait: (code: number) => void = () => {};
	private resolveKilled: (code: number) => void = () => {};
	private readonly waitPromise = new Promise<number>((resolve) => {
		this.resolveWait = resolve;
	});
	private readonly killedPromise = new Promise<number>((resolve) => {
		this.resolveKilled = resolve;
	});

	constructor(
		readonly pid: number,
		readonly container: ContainerInstance,
		readonly argv: readonly string[],
		private readonly run: (context: ProcessContext, argv: readonly string[]) => Promise<number>,
		private readonly runtime: Runtime,
	) {
		this.startedAt = runtime.nowMs();
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

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	get abortExitCode(): number {
		return this.killedExitCode ?? this.processExitCode ?? 143;
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
		if (!this.abortController.signal.aborted) {
			this.abortController.abort();
			this.resolveKilled(exitCode);
		}
		this.finish(exitCode);
	}

	trackListener(listener: { close(): void }): void {
		this.listeners.push(listener);
	}

	waitUntilKilled(): Promise<number> {
		if (this.abortController.signal.aborted) {
			return Promise.resolve(this.killedExitCode ?? this.processExitCode ?? 143);
		}
		return this.killedPromise;
	}

	exit(code: number): never {
		this.finish(code);
		throw new ProcessExit(code);
	}

	private finish(code: number): void {
		if (this.processState === "Exited") {
			return;
		}
		this.processState = "Exited";
		this.finishedAtMs = this.runtime.nowMs();
		this.processExitCode = code;
		for (const listener of this.listeners.splice(0)) {
			listener.close();
		}
		this.resolveWait(code);
	}
}

export class ProcessContext {
	constructor(
		private readonly process: ProcessInstance,
		private readonly runtime: Runtime,
	) {}

	get pid(): number {
		return this.process.pid;
	}

	get argv(): readonly string[] {
		return this.process.argv;
	}

	get env(): ReadonlyMap<string, string> {
		return this.process.container.env;
	}

	get container(): ContainerInstance {
		return this.process.container;
	}

	get pod(): PodSandboxInstance {
		return this.process.container.pod;
	}

	get kubeConfig(): KubeConfig {
		return this.runtime.kubeConfig();
	}

	get signal(): AbortSignal {
		return this.process.signal;
	}

	exec(argv: string[], options?: ExecOptions): ProcessInstance {
		return this.process.container.exec(argv, options);
	}

	listenHttp(port: number, handler: HttpHandler): HttpListener {
		const listener = this.process.container.pod.networkRegistration().bindHttp(port, handler);
		this.process.trackListener(listener);
		return listener;
	}

	listenDns(port: number, handler: DnsHandler): DnsListener {
		const listener = this.process.container.pod.networkRegistration().bindDns(port, handler);
		this.process.trackListener(listener);
		return listener;
	}

	async fetch(target: string, init?: HttpRequest): Promise<HttpResponse> {
		return await this.runtime.network.fetch(this.process.container.pod.networkPeer(), target, init);
	}

	async resolveDns(name: string, type: DnsRecordType = "A"): Promise<DnsResponse> {
		const dnsConfig = this.process.container.pod.config.dnsConfig;
		const serverIp = dnsConfig?.servers[0];
		if (!serverIp) {
			return { rcode: "NXDOMAIN", answers: [] };
		}
		for (const candidate of dnsLookupCandidates(name, dnsConfig.searches, dnsConfig.options)) {
			const response = await this.runtime.network.resolveDns(
				this.process.container.pod.networkPeer(),
				serverIp,
				{
					name: candidate,
					type,
				},
			);
			if (response.rcode !== "NXDOMAIN" || response.answers.length > 0) {
				return response;
			}
		}
		return { rcode: "NXDOMAIN", answers: [] };
	}

	sleep(ms: number): Promise<void> {
		return this.runtime.sleepUntil(this.signal, ms, () => this.process.abortExitCode);
	}

	waitUntilKilled(): Promise<number> {
		return this.process.waitUntilKilled();
	}

	exit(code = 0): never {
		return this.process.exit(code);
	}
}
