import type {
	V1Container,
	V1ContainerState,
	V1ContainerStatus,
	V1Pod,
	V1PodStatus,
} from "../../client";
import { Channel, select } from "../../channel";
import { CoreV1Api } from "../../client";
import type {
	ContainerConfig,
	ContainerPort,
	ContainerStatus,
	ExecResult,
	ImageSpec,
	PodSandboxConfig,
	PodSandboxStatus,
	PortMapping,
	Runtime,
} from "../cri";
import type { ContainerInstance } from "../cri";
import { buildContainerID } from "./container";
import { ProbeManager } from "./prober";
import type { ProbeUpdate } from "./prober";
import { PodWorkers } from "./pod-workers";
import type { PodRuntimeStatus, RuntimePod } from "../cri";
import { retryConflicts } from "../../retry-update";
import { Server } from "../server";
import { PodStore } from "../storage";
import { EventRecorder } from "../events";
import { StatusManager } from "./status";
import type { Watcher } from "../storage/watch";

interface RunningPod {
	sandboxId: string;
}

interface PodUpdate {
	op: "ADD" | "DELETE" | "UPDATE";
	pods: V1Pod[];
}

interface PodActions {
	createSandbox: boolean;
	killSandbox: boolean;
	containersToStart: V1Container[];
	containersToKill: ContainerInstance[];
}

function podKey(pod: V1Pod): string {
	return `${pod.metadata?.namespace ?? "default"}/${pod.metadata?.name ?? ""}`;
}

function runtimeProtocol(protocol: string | undefined): ContainerPort["protocol"] | undefined {
	switch (protocol) {
		case "TCP":
		case "UDP":
		case "SCTP":
			return protocol;
		default:
			return undefined;
	}
}

export class Kubelet {
	server: Server;
	private readonly containerRuntime: Runtime;
	private readonly pods: PodStore;
	private watcher: Watcher<V1Pod> | undefined;
	private readonly runningPods = new Map<string, RunningPod>();
	private readonly probeManager: ProbeManager;
	private readonly podWorkers: PodWorkers;
	private readonly statusManager: StatusManager;
	private readonly events: EventRecorder;
	private readonly podUpdates = new Channel<PodUpdate>(50);
	private stopped = false;

	public constructor(server: Server) {
		this.server = server;
		this.containerRuntime = server.runtime;
		this.pods = new PodStore(server.cluster.etcd);
		this.events = new EventRecorder({
			api: server.cluster.kubeConfig.makeApiClient(CoreV1Api),
			clock: server.cluster.clock,
			component: "kubelet",
			host: server.name,
		});
		this.statusManager = new StatusManager({
			clock: server.cluster.clock,
			pods: this.pods,
		});
		this.probeManager = new ProbeManager({
			clock: server.cluster.clock,
			runtime: this.containerRuntime,
			statusManager: this.statusManager,
		});
		this.podWorkers = new PodWorkers(
			server.cluster.clock,
			(pod) => this.syncPod(pod),
			(pod) => this.containerRuntime.getPodStatus(this.getRuntimePod(pod)),
			(pod, podStatus, gracePeriod, podStatusFn) =>
				this.syncTerminatingPod(pod, podStatus, gracePeriod, podStatusFn),
			(pod, podStatus) => this.syncTerminatedPod(pod, podStatus),
		);
	}

	async start(): Promise<void> {
		this.syncLoop();
		await this.reconcileExistingPods();
		this.watcher = await this.pods.watch();
		this.watcher.on("event", (event, pod) => {
			switch (event) {
				case "ADDED":
					this.sendPodUpdate({ op: "ADD", pods: [pod] });
					return;
				case "MODIFIED":
					this.sendPodUpdate({ op: "UPDATE", pods: [pod] });
					return;
				case "DELETED":
					this.sendPodUpdate({ op: "DELETE", pods: [pod] });
					return;
			}
		});
	}

	close(): void {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		this.podUpdates.close();
		this.probeManager.close();
		this.podWorkers.close();
		this.statusManager.close();
		void this.watcher?.cancel();
		for (const pod of this.runningPods.values()) {
			void this.containerRuntime.removePodSandbox(pod.sandboxId);
		}
		this.runningPods.clear();
	}

	private sendPodUpdate(update: PodUpdate): void {
		if (this.stopped) {
			return;
		}
		void this.podUpdates.send(update).catch(() => {});
	}

	// Models the channel dispatch shape of kubernetes/pkg/kubelet/kubelet.go
	// syncLoopIteration for the simulator's currently modeled pod config and
	// probe-manager cases.
	private syncLoop(): void {
		void this.syncLoopIteration();
	}

	private async syncLoopIteration(): Promise<void> {
		while (!this.stopped) {
			const selected = await select()
				.case(this.podUpdates, async ({ ok, value }) => {
					if (!ok) {
						return "closed";
					}
					await this.handlePodUpdate(value);
					return "handled";
				})
				.case(this.probeManager.livenessManager.updates(), async ({ ok, value }) => {
					if (!ok) {
						return "closed";
					}
					if (value.result === "failure") {
						await this.handleProbeSync(value, "liveness", "unhealthy");
					}
					return "handled";
				})
				.case(this.probeManager.readinessManager.updates(), async ({ ok, value }) => {
					if (!ok) {
						return "closed";
					}
					const ready = value.result === "success";
					await this.statusManager.setContainerReadiness(value.podUid, value.containerId, ready);

					const status = ready ? "ready" : "not ready";
					await this.handleProbeSync(value, "readiness", status);
					return "handled";
				})
				.case(this.probeManager.startupManager.updates(), async ({ ok, value }) => {
					if (!ok) {
						return "closed";
					}
					const started = value.result === "success";
					await this.statusManager.setContainerStartup(value.podUid, value.containerId, started);

					const status = started ? "started" : "unhealthy";
					await this.handleProbeSync(value, "startup", status);
					return "handled";
				});
			if (selected === "closed") {
				return;
			}
		}
	}

	private async handlePodUpdate(update: PodUpdate): Promise<void> {
		switch (update.op) {
			case "ADD":
				this.handlePodAdditions(update.pods);
				return;
			case "UPDATE":
				this.handlePodUpdates(update.pods);
				return;
			case "DELETE":
				for (const pod of update.pods) {
					await this.deletePodStatus(pod);
				}
				return;
		}
	}

	// Models kubernetes/pkg/kubelet/kubelet.go handleProbeSync.
	private async handleProbeSync(
		update: ProbeUpdate,
		probe: "liveness" | "readiness" | "startup",
		status: string,
	): Promise<void> {
		if (this.stopped || !update.podUid) {
			return;
		}
		void probe;
		void status;
		// We should not use the pod from the prober manager, because it is never
		// updated after initialization.
		const pod = await this.findPodByUid(update.podUid);
		if (!pod) {
			return;
		}
		this.handlePodSyncs([pod]);
	}

	private async reconcileExistingPods(): Promise<void> {
		this.handlePodSyncs(await this.pods.list());
	}

	// Models kubernetes/pkg/kubelet/kubelet.go HandlePodAdditions.
	private handlePodAdditions(pods: V1Pod[]): void {
		const start = this.server.cluster.clock.now();
		for (const pod of pods) {
			if (this.stopped || pod.spec?.nodeName !== this.server.name || !pod.metadata?.name) {
				continue;
			}
			this.podWorkers.updatePod({
				pod,
				updateType: "create",
				startTime: start,
			});
		}
	}

	// Models kubernetes/pkg/kubelet/kubelet.go HandlePodUpdates.
	private handlePodUpdates(pods: V1Pod[]): void {
		const start = this.server.cluster.clock.now();
		for (const pod of pods) {
			if (this.stopped || pod.spec?.nodeName !== this.server.name || !pod.metadata?.name) {
				continue;
			}
			this.podWorkers.updatePod({
				pod,
				updateType: "update",
				startTime: start,
			});
		}
	}

	// Models kubernetes/pkg/kubelet/kubelet.go HandlePodSyncs.
	private handlePodSyncs(pods: V1Pod[]): void {
		const start = this.server.cluster.clock.now();
		for (const pod of pods) {
			if (this.stopped || pod.spec?.nodeName !== this.server.name || !pod.metadata?.name) {
				continue;
			}
			this.podWorkers.updatePod({
				pod,
				updateType: "sync",
				startTime: start,
			});
		}
	}

	private async deletePodStatus(pod: V1Pod): Promise<void> {
		const key = podKey(pod);
		const running = this.runningPods.get(key);
		this.probeManager.removePod(pod);
		this.podWorkers.removePod(pod);
		this.statusManager.removePod(pod);
		if (!running) {
			return;
		}
		const sandbox = this.containerRuntime.getPodSandbox(running.sandboxId);
		for (const container of sandbox?.containers.values() ?? []) {
			await this.events.event(pod, "Normal", "Killing", `Stopping container ${container.name}`);
		}
		this.runningPods.delete(key);
		await this.containerRuntime.removePodSandbox(running.sandboxId);
	}

	async exec(
		namespace: string,
		podName: string,
		containerName: string | undefined,
		argv: string[],
	): Promise<ExecResult> {
		const running = this.runningPods.get(`${namespace}/${podName}`);
		if (!running) {
			throw new Error(`pod ${namespace}/${podName} is not running on node ${this.server.name}`);
		}
		const sandbox = this.containerRuntime.getPodSandbox(running.sandboxId);
		if (!sandbox) {
			throw new Error(`pod sandbox ${running.sandboxId} not found`);
		}
		const containers = [...sandbox.containers.values()];
		const container = containerName
			? containers.find((candidate) => candidate.name === containerName)
			: containers.length === 1
				? containers[0]
				: undefined;
		if (!container) {
			throw new Error(
				containerName
					? `container ${containerName} not found in pod ${namespace}/${podName}`
					: `container name is required for pod ${namespace}/${podName}`,
			);
		}
		return await this.containerRuntime.execSync(container.id, argv);
	}

	private async syncPod(pod: V1Pod): Promise<void> {
		this.probeManager.addPod(pod);
		const key = podKey(pod);
		let running = this.runningPods.get(key);
		let sandboxStatus = running
			? this.containerRuntime.podSandboxStatus(running.sandboxId)
			: undefined;
		const actions = this.computePodActions(pod, running?.sandboxId, sandboxStatus);

		if (actions.killSandbox && running) {
			const sandbox = this.containerRuntime.getPodSandbox(running.sandboxId);
			for (const container of sandbox?.containers.values() ?? []) {
				await this.events.event(pod, "Normal", "Killing", `Stopping container ${container.name}`);
			}
			await this.containerRuntime.removePodSandbox(running.sandboxId);
			this.runningPods.delete(key);
			running = undefined;
			sandboxStatus = undefined;
		} else {
			for (const container of actions.containersToKill) {
				await this.events.event(pod, "Normal", "Killing", `Stopping container ${container.name}`);
				await this.containerRuntime.stopContainer(container.id);
				await this.containerRuntime.removeContainer(container.id);
			}
		}

		if (actions.createSandbox) {
			const sandboxConfig = this.podSandboxConfig(pod);
			const sandboxId = await this.containerRuntime.runPodSandbox(sandboxConfig);
			running = { sandboxId };
			this.runningPods.set(key, running);
			sandboxStatus = this.containerRuntime.podSandboxStatus(sandboxId);
			await this.updatePodStatus(pod, sandboxId, sandboxStatus);
		}

		if (!running) {
			return;
		}

		const sandboxConfig = this.podSandboxConfig(pod);
		for (const container of actions.containersToStart) {
			await this.startContainer(
				pod,
				running.sandboxId,
				sandboxConfig,
				container,
				this.nextRestartCount(pod, container.name),
			);
		}

		await this.updatePodStatus(pod, running.sandboxId, sandboxStatus);
	}

	// Models kubernetes/pkg/kubelet/kubelet.go SyncTerminatingPod.
	private async syncTerminatingPod(
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
		gracePeriod: number | undefined,
		podStatusFn: ((status: V1PodStatus) => void) | undefined,
	): Promise<void> {
		const apiPodStatus = this.generateAPIPodStatus(pod, podStatus, false);
		podStatusFn?.(apiPodStatus);
		await this.statusManager.setPodStatus(pod, apiPodStatus);

		this.probeManager.stopLivenessAndStartup(pod);

		await this.killPod(pod, gracePeriod);

		this.probeManager.removePod(pod);

		const runtimePod = this.getRuntimePod(pod);
		const stoppedPodStatus = this.containerRuntime.getPodStatus(runtimePod);
		this.preserveDataFromBeforeStopping(stoppedPodStatus, podStatus);

		const runningContainers: string[] = [];
		for (const status of stoppedPodStatus.containerStatuses) {
			if (status.state === "Running") {
				runningContainers.push(status.id);
			}
		}
		if (runningContainers.length > 0) {
			throw new Error(
				`detected running containers after a successful KillPod, CRI violation: ${runningContainers.join(", ")}`,
			);
		}

		// Kubernetes unprepares DynamicResourceAllocation resources here. The
		// simulator does not model DRA, volumes, or CSI resources.
		await this.statusManager.setPodStatus(
			pod,
			this.generateAPIPodStatus(pod, stoppedPodStatus, true),
		);
	}

	// Models kubernetes/pkg/kubelet/kubelet.go SyncTerminatedPod.
	private async syncTerminatedPod(pod: V1Pod, podStatus: PodRuntimeStatus): Promise<void> {
		const apiPodStatus = this.generateAPIPodStatus(pod, podStatus, true);
		await this.statusManager.setPodStatus(pod, apiPodStatus);

		// Kubernetes waits for volume teardown, unregisters secret/configmap
		// managers, and releases cgroups/user namespaces here. The simulator does
		// not model those resources, but it does tear down its in-memory CRI pod.
		await this.cleanupPodRuntime(pod);

		await this.statusManager.terminatePod(pod);
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go killPod.
	private async killPod(pod: V1Pod, gracePeriod: number | undefined): Promise<void> {
		const key = podKey(pod);
		const running = this.runningPods.get(key);
		if (running) {
			const sandbox = this.containerRuntime.getPodSandbox(running.sandboxId);
			if (gracePeriod !== undefined) {
				await this.server.cluster.clock.wait(gracePeriod * 1000);
			}
			for (const container of sandbox?.containers.values() ?? []) {
				await this.events.event(pod, "Normal", "Killing", `Stopping container ${container.name}`);
				await this.containerRuntime.stopContainer(container.id, gracePeriod);
			}
			sandbox?.unregisterNetwork();
			sandbox?.setReady(false);
		}
	}

	private async cleanupPodRuntime(pod: V1Pod): Promise<void> {
		const key = podKey(pod);
		const running = this.runningPods.get(key);
		if (!running) {
			return;
		}
		await this.containerRuntime.removePodSandbox(running.sandboxId);
		this.runningPods.delete(key);
	}

	// Models kubernetes/pkg/kubelet/kubelet.go preserveDataFromBeforeStopping.
	private preserveDataFromBeforeStopping(
		stoppedPodStatus: PodRuntimeStatus,
		podStatus: PodRuntimeStatus,
	): void {
		stoppedPodStatus.ip = podStatus.ip;
	}

	private getRuntimePod(pod: V1Pod): RuntimePod {
		const runtimePod = this.containerRuntime.getPod(pod.metadata?.uid ?? "");
		if (runtimePod) {
			return runtimePod;
		}
		return this.emptyRuntimePod(pod);
	}

	private emptyRuntimePod(pod: V1Pod): RuntimePod {
		return {
			id: pod.metadata?.uid ?? "",
			name: pod.metadata?.name ?? "",
			namespace: pod.metadata?.namespace ?? "default",
			createdAt: this.server.cluster.clock.nowMs(),
			sandboxes: [],
		};
	}

	private computePodActions(
		pod: V1Pod,
		sandboxId: string | undefined,
		sandboxStatus: PodSandboxStatus | undefined,
	): PodActions {
		const containers = pod.spec?.containers ?? [];
		const restartPolicy = pod.spec?.restartPolicy ?? "Always";
		const sandboxReady =
			!!sandboxId &&
			!!sandboxStatus &&
			sandboxStatus.state === "Ready" &&
			sandboxStatus.network?.ip !== undefined;
		const createSandbox = !sandboxReady;
		const actions: PodActions = {
			createSandbox,
			killSandbox: !sandboxReady && sandboxId !== undefined,
			containersToStart: [],
			containersToKill: [],
		};

		if (!sandboxReady) {
			if (restartPolicy === "Never" && this.hasPreviousStatuses(pod)) {
				actions.createSandbox = false;
				return actions;
			}
			actions.containersToStart = containers.filter((container) =>
				this.shouldStartInFreshSandbox(pod, container),
			);
			return actions;
		}

		const sandbox = this.containerRuntime.getPodSandbox(sandboxId);
		if (!sandbox) {
			actions.createSandbox = true;
			return actions;
		}

		for (const spec of containers) {
			const current = [...sandbox.containers.values()]
				.filter((container) => container.name === spec.name)
				.toSorted((left, right) => right.createdAt - left.createdAt)[0];
			if (!current) {
				if (this.shouldRestartMissingOrExited(pod, spec, undefined)) {
					actions.containersToStart.push(spec);
				}
				continue;
			}

			const status = current.status();
			const probeFailed = this.probeFailed(current.id);
			const specChanged = this.containerSpecChanged(spec, current.config);
			if (status.state === "Running") {
				if (specChanged || probeFailed) {
					actions.containersToKill.push(current);
					if (specChanged || this.shouldRestartAfterFailure(restartPolicy)) {
						actions.containersToStart.push(spec);
					}
				}
				continue;
			}

			if (status.state === "Created" || this.shouldRestartMissingOrExited(pod, spec, status)) {
				actions.containersToKill.push(current);
				actions.containersToStart.push(spec);
			}
		}

		const keptRunning = [...sandbox.containers.values()].some(
			(container) =>
				!actions.containersToKill.includes(container) && container.status().state === "Running",
		);
		if (!keptRunning && actions.containersToStart.length === 0) {
			actions.killSandbox = true;
		}
		return actions;
	}

	private async startContainer(
		pod: V1Pod,
		sandboxId: string,
		sandboxConfig: PodSandboxConfig,
		container: V1Container,
		attempt: number,
	): Promise<void> {
		const image = this.containerImage(container);
		const imageRef = await this.containerRuntime.pullImage(image);
		await this.events.event(
			pod,
			"Normal",
			"Pulled",
			`Container image "${container.image ?? ""}" already present on machine`,
		);
		const containerId = await this.containerRuntime.createContainer(
			sandboxId,
			this.containerConfig(container, imageRef, attempt),
			sandboxConfig,
		);
		await this.events.event(pod, "Normal", "Created", `Created container: ${container.name}`);
		await this.containerRuntime.startContainer(containerId);
		await this.events.event(pod, "Normal", "Started", `Started container ${container.name}`);
	}

	private containerImage(container: V1Container): ImageSpec {
		return { image: container.image ?? "" };
	}

	private podSandboxConfig(pod: V1Pod): PodSandboxConfig {
		const namespace = pod.metadata?.namespace ?? "default";
		return {
			metadata: {
				uid: pod.metadata?.uid ?? `${namespace}/${pod.metadata?.name ?? ""}`,
				name: pod.metadata?.name ?? "",
				namespace,
				attempt: 0,
			},
			hostname: pod.spec?.hostname ?? pod.metadata?.name,
			dnsConfig: {
				servers: [this.server.cluster.dnsServiceIp],
				searches: [`${namespace}.svc.cluster.local`, "svc.cluster.local", "cluster.local"],
				options: ["ndots:5"],
			},
			labels: pod.metadata?.labels,
			annotations: pod.metadata?.annotations,
			portMappings: this.podPortMappings(pod),
		};
	}

	private podPortMappings(pod: V1Pod): PortMapping[] | undefined {
		const portMappings = (pod.spec?.containers ?? []).flatMap((container) =>
			(container.ports ?? []).map((port) => ({
				hostIp: port.hostIP,
				hostPort: port.hostPort,
				containerPort: port.containerPort,
				protocol: runtimeProtocol(port.protocol),
			})),
		);
		return portMappings.length > 0 ? portMappings : undefined;
	}

	private containerConfig(
		container: V1Container,
		imageRef: string,
		attempt: number,
	): ContainerConfig {
		return {
			metadata: {
				name: container.name,
				attempt,
			},
			image: {
				image: imageRef,
			},
			command: container.command,
			args: container.args,
			env: Object.fromEntries(
				(container.env ?? [])
					.filter((env) => env.value !== undefined)
					.map((env) => [env.name, env.value ?? ""]),
			),
			ports: (container.ports ?? []).map((port) => ({
				name: port.name,
				containerPort: port.containerPort,
				protocol: runtimeProtocol(port.protocol),
			})),
		};
	}

	private async updatePodStatus(
		pod: V1Pod,
		sandboxId: string,
		sandboxStatus?: PodSandboxStatus,
	): Promise<void> {
		const name = pod.metadata?.name;
		const namespace = pod.metadata?.namespace;
		if (!name) {
			return;
		}
		const sandbox = sandboxStatus ?? this.containerRuntime.podSandboxStatus(sandboxId);
		const runtimeSandbox = this.containerRuntime.getPodSandbox(sandboxId);
		const podStatus: PodRuntimeStatus = {
			ip: sandbox.network?.ip,
			containerStatuses: [...(runtimeSandbox?.containers.values() ?? [])].map((container) =>
				this.containerRuntime.containerStatus(container.id),
			),
		};
		await retryConflicts(
			async () => {
				const current = await this.pods.get(name, namespace);
				if (!current) {
					return;
				}
				await this.statusManager.setPodStatus(
					current,
					this.generateAPIPodStatus(pod, podStatus, false, current.status),
				);
			},
			{
				clock: this.server.cluster.clock,
			},
		);
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go generateAPIPodStatus.
	private generateAPIPodStatus(
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
		podIsTerminal: boolean,
		currentStatus = pod.status,
	): V1PodStatus {
		const status = this.convertStatusToAPIStatus(pod, podStatus, currentStatus);
		status.phase = podIsTerminal ? "Failed" : status.phase;
		if (
			status.phase !== "Failed" &&
			status.phase !== "Succeeded" &&
			(currentStatus?.phase === "Failed" || currentStatus?.phase === "Succeeded")
		) {
			status.phase = currentStatus.phase;
		}
		this.probeManager.updatePodStatus(pod, status);
		return this.statusManager.derivePodConditions(pod, status);
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go convertStatusToAPIStatus.
	private convertStatusToAPIStatus(
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
		currentStatus: V1PodStatus | undefined,
	): V1PodStatus {
		const containerStatuses = podStatus.containerStatuses.map((status) =>
			this.podContainerStatus(status),
		);
		const byName = new Map(containerStatuses.map((status) => [status.name, status]));
		const orderedStatuses = (pod.spec?.containers ?? [])
			.map((container) => byName.get(container.name))
			.filter((status): status is V1ContainerStatus => status !== undefined);
		const running = orderedStatuses.some((status) => status.state?.running);
		const terminated = orderedStatuses.some((status) => status.state?.terminated);
		return {
			...currentStatus,
			phase: running ? "Running" : terminated ? "Failed" : "Pending",
			podIP: podStatus.ip,
			podIPs: podStatus.ip ? [{ ip: podStatus.ip }] : undefined,
			containerStatuses: orderedStatuses,
		};
	}

	private podContainerStatus(status: ContainerStatus): V1ContainerStatus {
		return {
			name: status.name,
			image: status.imageRef,
			imageID: status.imageRef,
			containerID: buildContainerID("simulator", status.id).toString(),
			ready: false,
			restartCount: status.restartCount,
			started: status.state === "Running",
			state: this.containerState(status),
		};
	}

	private containerState(status: ContainerStatus): V1ContainerState {
		switch (status.state) {
			case "Running":
				return { running: { startedAt: new Date(status.startedAt ?? status.createdAt) } };
			case "Exited":
				return {
					terminated: {
						exitCode: status.exitCode ?? 0,
						startedAt: status.startedAt ? new Date(status.startedAt) : undefined,
						finishedAt: status.finishedAt ? new Date(status.finishedAt) : undefined,
						reason: status.reason,
						message: status.message,
						containerID: buildContainerID("simulator", status.id).toString(),
					},
				};
			case "Created":
				return { waiting: { reason: "ContainerCreating" } };
		}
	}

	private probeFailed(containerId: string): boolean {
		const id = buildContainerID("simulator", containerId);
		return (
			this.probeManager.result("liveness", id) === "failure" ||
			this.probeManager.result("startup", id) === "failure"
		);
	}

	private shouldRestartAfterFailure(restartPolicy: string): boolean {
		return restartPolicy === "Always" || restartPolicy === "OnFailure";
	}

	private shouldRestartMissingOrExited(
		pod: V1Pod,
		container: V1Container,
		status: ContainerStatus | undefined,
	): boolean {
		const previous = this.previousContainerStatus(pod, container.name);
		const restartPolicy = pod.spec?.restartPolicy ?? "Always";
		if (!status && !previous) {
			return true;
		}
		const exitCode = status?.exitCode ?? previous?.state?.terminated?.exitCode;
		switch (restartPolicy) {
			case "Never":
				return !previous && !status;
			case "OnFailure":
				return exitCode === undefined || exitCode !== 0;
			default:
				return true;
		}
	}

	private shouldStartInFreshSandbox(pod: V1Pod, container: V1Container): boolean {
		const previous = this.previousContainerStatus(pod, container.name);
		if (!previous) {
			return true;
		}
		if (pod.spec?.restartPolicy === "OnFailure") {
			return previous.state?.terminated?.exitCode !== 0;
		}
		return pod.spec?.restartPolicy !== "Never";
	}

	private hasPreviousStatuses(pod: V1Pod): boolean {
		return (pod.status?.containerStatuses?.length ?? 0) > 0;
	}

	private previousContainerStatus(
		pod: V1Pod,
		containerName: string,
	): V1ContainerStatus | undefined {
		return pod.status?.containerStatuses?.find((status) => status.name === containerName);
	}

	private nextRestartCount(pod: V1Pod, containerName: string): number {
		const previous = this.previousContainerStatus(pod, containerName);
		return previous ? previous.restartCount + 1 : 0;
	}

	private containerSpecChanged(spec: V1Container, config: ContainerConfig): boolean {
		return (
			(spec.image ?? "") !== config.image.image ||
			JSON.stringify(spec.command ?? []) !== JSON.stringify(config.command ?? []) ||
			JSON.stringify(spec.args ?? []) !== JSON.stringify(config.args ?? []) ||
			JSON.stringify(
				Object.fromEntries(
					(spec.env ?? [])
						.filter((env) => env.value !== undefined)
						.map((env) => [env.name, env.value ?? ""]),
				),
			) !== JSON.stringify(config.env ?? {}) ||
			JSON.stringify(
				(spec.ports ?? []).map((port) => ({
					name: port.name,
					containerPort: port.containerPort,
					protocol: runtimeProtocol(port.protocol),
				})),
			) !== JSON.stringify(config.ports ?? [])
		);
	}

	private async findPodByUid(uid: string): Promise<V1Pod | undefined> {
		return (await this.pods.list()).find((pod) => pod.metadata?.uid === uid);
	}
}
