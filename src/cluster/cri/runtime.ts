import type { Clock } from "../../clock";
import { select } from "../../go/channel";
import * as context from "../../go/context";
import * as time from "../../go/time";
import type { KubeConfig } from "../../client/types";
import { ipToNumber } from "../../net";
import type { DnsHandler, DnsListener, DnsRecordType, DnsResponse } from "../cni/dns";
import { NetworkError } from "../cni/error";
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
	stdout: string;
	stderr: string;
}

export interface RuntimeOptions {
	clock: Clock;
	kubeConfig: KubeConfig;
	network: ClusterNetwork;
	podCIDR: string;
	imageRegistry: ImageRegistry;
	idPrefix?: string;
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

function parseHttpUrl(target: string): URL {
	let url: URL;
	try {
		url = new URL(target);
	} catch (error) {
		throw new NetworkError(`invalid HTTP target ${target}`, { cause: error });
	}
	if (url.protocol !== "http:") {
		throw new NetworkError(`unsupported protocol ${url.protocol}`);
	}
	return url;
}

function withHostHeader(request: HttpRequest, host: string): HttpRequest {
	const headers = { ...request.headers };
	if (!Object.keys(headers).some((key) => key.toLowerCase() === "host")) {
		headers.host = host;
	}
	return { ...request, headers };
}

function getContainersToDeleteInPod(
	filterContainerId: string,
	podStatus: PodRuntimeStatus,
	containersToKeep: number,
): ContainerStatus[] {
	const matchedContainer = filterContainerId
		? podStatus.containerStatuses.find(
				(containerStatus) => containerStatus.id === filterContainerId,
			)
		: undefined;
	if (filterContainerId && !matchedContainer) {
		return [];
	}

	const candidates = podStatus.containerStatuses
		.filter((containerStatus) => containerStatus.state === "Exited")
		.filter(
			(containerStatus) =>
				matchedContainer === undefined || matchedContainer.name === containerStatus.name,
		)
		.toSorted((left, right) => right.createdAt - left.createdAt);
	if (candidates.length <= containersToKeep) {
		return [];
	}
	return candidates.slice(containersToKeep);
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

export interface RuntimeContainer {
	id: string;
	name: string;
	state: ContainerState;
	createdAt: number;
}

export interface RuntimePod {
	id: string;
	name: string;
	namespace: string;
	timestamp: Date;
	containers: RuntimeContainer[];
	sandboxes: RuntimeContainer[];
	containerStatuses: ContainerStatus[];
	sandboxStatuses: PodSandboxStatus[];
}

export interface PodRuntimeStatus {
	id: string;
	ip?: string;
	ips: string[];
	containerStatuses: ContainerStatus[];
	sandboxStatuses: PodSandboxStatus[];
}

export class Runtime {
	readonly clock: Clock;
	readonly kubeConfig: KubeConfig;
	readonly network: ClusterNetwork;
	readonly imageRegistry: ImageRegistry;
	private readonly podCIDR: string;
	private readonly idPrefix: string;
	private readonly sandboxes = new Map<string, PodSandboxInstance>();
	private readonly containers = new Map<string, ContainerInstance>();
	private readonly processes = new Map<number, ProcessInstance>();
	private nextSandboxId = 1;
	private nextContainerId = 1;
	private nextPid = 1;

	constructor(options: RuntimeOptions) {
		this.clock = options.clock;
		this.kubeConfig = options.kubeConfig;
		this.network = options.network;
		this.imageRegistry = options.imageRegistry;
		this.podCIDR = options.podCIDR;
		this.idPrefix = options.idPrefix ?? "";
	}

	async runPodSandbox(config: PodSandboxConfig): Promise<string> {
		const sandbox = new PodSandboxInstance(
			`${this.idPrefix}sandbox-${this.nextSandboxId++}`,
			config,
			this.nowMs(),
		);
		sandbox.setNetworkRegistration(this.network.setupPodSandbox(sandbox, this.podCIDR));
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

	async close(): Promise<void> {
		for (const sandbox of [...this.sandboxes.values()]) {
			await this.removePodSandbox(sandbox.id);
		}
		for (const process of [...this.processes.values()]) {
			await process.kill("SIGKILL");
		}
	}

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

	getPods(_all: boolean): RuntimePod[] {
		const podUIDs = new Set([...this.sandboxes.values()].map((sandbox) => sandbox.uid));
		return [...podUIDs]
			.map((podUID) => this.getPod(podUID))
			.filter((pod): pod is RuntimePod => pod !== undefined);
	}

	getPod(podUid: string): RuntimePod | undefined {
		const sandboxes = this.getPodSandboxesByPodUid(podUid);
		const latest = sandboxes[0];
		if (!latest) {
			return undefined;
		}
		return {
			id: podUid,
			name: latest.name,
			namespace: latest.namespace,
			timestamp: this.clock.now(),
			containers: sandboxes.flatMap((sandbox) =>
				[...sandbox.containers.values()].map((container) => this.runtimeContainer(container)),
			),
			sandboxes: sandboxes.map((sandbox) => this.runtimeSandboxContainer(sandbox)),
			containerStatuses: sandboxes.flatMap((sandbox) =>
				[...sandbox.containers.values()].map((container) => container.status()),
			),
			sandboxStatuses: sandboxes.map((sandbox) => sandbox.status()),
		};
	}

	getPodStatus(pod: RuntimePod): PodRuntimeStatus {
		const ips = pod.sandboxStatuses
			.map((status) => status.network?.ip)
			.filter((ip): ip is string => ip !== undefined);
		return {
			id: pod.id,
			ip: ips[0],
			ips,
			containerStatuses: pod.containerStatuses.map((status) => ({ ...status })),
			sandboxStatuses: pod.sandboxStatuses.map((status) => ({
				...status,
				metadata: { ...status.metadata },
				network: status.network ? { ...status.network } : undefined,
				labels: { ...status.labels },
				annotations: { ...status.annotations },
			})),
		};
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
			`${this.idPrefix}container-${this.nextContainerId++}`,
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

	async deleteContainersInPod(
		filterContainerId: string,
		podStatus: PodRuntimeStatus,
		removeAll: boolean,
		containersToKeep: number,
	): Promise<void> {
		let keep = containersToKeep;
		let filter = filterContainerId;
		if (removeAll) {
			keep = 0;
			filter = "";
		}

		for (const candidate of getContainersToDeleteInPod(filter, podStatus, keep)) {
			await this.removeContainer(candidate.id);
		}
	}

	getContainer(containerId: string): ContainerInstance | undefined {
		return this.containers.get(containerId);
	}

	containerStatus(containerId: string): ContainerStatus {
		return this.containerOrThrow(containerId).status();
	}

	findContainer(podSandboxId: string, containerName: string): ContainerInstance | undefined {
		const sandbox = this.sandboxes.get(podSandboxId);
		if (!sandbox) {
			return undefined;
		}
		return [...sandbox.containers.values()]
			.filter((container) => container.name === containerName)
			.toSorted((left, right) => right.createdAt - left.createdAt)[0];
	}

	async execSync(
		containerId: string,
		argv: string[],
		options: ExecOptions = {},
	): Promise<ExecResult> {
		const process = this.containerOrThrow(containerId).exec(argv, options);
		const exitCode = await this.waitForProcess(process, options.timeoutMs);
		return { exitCode, stdout: process.stdout, stderr: process.stderr };
	}

	createProcess(
		container: ContainerInstance,
		argv: readonly string[],
		run: (context: ProcessContext, argv: readonly string[]) => Promise<number>,
	): ProcessInstance {
		const process = new ProcessInstance(this.nextPid++, container, argv, run, this);
		this.processes.set(process.pid, process);
		return process;
	}

	forgetProcess(pid: number): void {
		this.processes.delete(pid);
	}

	async sleepUntil(ctx: context.Context, ms: number, exitCode: () => number): Promise<void> {
		if (ctx.err()) {
			return Promise.reject(new ProcessExit(exitCode()));
		}
		const selected = await select()
			.case(ctx.done(), () => "done")
			.case(time.after(this.clock, ms), () => "timeout");
		if (selected === "done") {
			throw new ProcessExit(exitCode());
		}
	}

	nowMs(): number {
		return this.clock.nowMs();
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
					timeoutHandle = this.clock.setTimeout(() => resolve(124), timeoutMs);
				}),
			]);
		} finally {
			if (timeoutHandle !== undefined) {
				this.clock.clearTimeout(timeoutHandle);
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

	private runtimeContainer(container: ContainerInstance): RuntimeContainer {
		const status = container.status();
		return {
			id: status.id,
			name: status.name,
			state: status.state,
			createdAt: status.createdAt,
		};
	}

	private runtimeSandboxContainer(sandbox: PodSandboxInstance): RuntimeContainer {
		const status = sandbox.status();
		return {
			id: status.id,
			name: status.metadata.name,
			state: status.state === "Ready" ? "Running" : "Exited",
			createdAt: status.createdAt,
		};
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
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private readonly ctx: context.Context;
	private readonly cancelContext: context.CancelFunc;
	private readonly listeners: Array<{ close(): void }> = [];
	private resolveWait: (code: number) => void = () => {};
	private readonly waitPromise = new Promise<number>((resolve) => {
		this.resolveWait = resolve;
	});

	constructor(
		readonly pid: number,
		readonly container: ContainerInstance,
		readonly argv: readonly string[],
		private readonly run: (context: ProcessContext, argv: readonly string[]) => Promise<number>,
		private readonly runtime: Runtime,
	) {
		this.startedAt = runtime.nowMs();
		[this.ctx, this.cancelContext] = context.withCancel(context.background());
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

	get context(): context.Context {
		return this.ctx;
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
		this.finishedAtMs = this.runtime.nowMs();
		this.processExitCode = code;
		this.cancelContext();
		this.runtime.forgetProcess(this.pid);
		for (const listener of this.listeners.splice(0)) {
			listener.close();
		}
		this.resolveWait(code);
	}
}

export class ProcessContext implements context.Context {
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

	fsRead(path: string): string | undefined {
		return this.process.container.fs.read(path);
	}

	fsWrite(path: string, contents = ""): void {
		this.process.container.fs.write(path, contents);
	}

	fsDelete(path: string): boolean {
		return this.process.container.fs.delete(path);
	}

	fsHas(path: string): boolean {
		return this.process.container.fs.has(path);
	}

	get pod(): PodSandboxInstance {
		return this.process.container.pod;
	}

	get kubeConfig(): KubeConfig {
		return this.runtime.kubeConfig;
	}

	get clock(): Clock {
		return this.runtime.clock;
	}

	done(): ReturnType<context.Context["done"]> {
		return this.process.context.done();
	}

	err(): ReturnType<context.Context["err"]> {
		return this.process.context.err();
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
		const url = parseHttpUrl(target);
		const request = init ?? {};
		if (ipToNumber(url.hostname) !== undefined) {
			return await this.runtime.network.fetch(url.toString(), request);
		}

		const originalHost = url.host;
		const resolved = await this.resolveHostname(url.hostname);
		if (!resolved) {
			throw new NetworkError(`could not resolve ${url.hostname}`);
		}
		url.hostname = resolved;
		return await this.runtime.network.fetch(url.toString(), withHostHeader(request, originalHost));
	}

	async resolveDns(name: string, type: DnsRecordType = "A"): Promise<DnsResponse> {
		const dnsConfig = this.process.container.pod.config.dnsConfig;
		const serverIp = dnsConfig?.servers[0];
		if (!serverIp) {
			return { rcode: "NXDOMAIN", answers: [] };
		}
		for (const candidate of dnsLookupCandidates(name, dnsConfig.searches, dnsConfig.options)) {
			const response = await this.runtime.network.sendDns(`${serverIp}:53`, {
				name: candidate,
				type,
			});
			if (response.rcode !== "NXDOMAIN" || response.answers.length > 0) {
				return response;
			}
		}
		return { rcode: "NXDOMAIN", answers: [] };
	}

	private async resolveHostname(name: string): Promise<string | undefined> {
		const response = await this.resolveDns(name, "A");
		const answer = response.answers.find((value) => value.type === "A");
		return answer?.type === "A" ? answer.address : undefined;
	}

	sleep(ms: number): Promise<void> {
		return this.runtime.sleepUntil(this.process.context, ms, () => this.process.abortExitCode);
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
