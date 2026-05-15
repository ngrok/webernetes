import type {
	V1Container,
	V1ContainerState,
	V1ContainerStatus,
	V1Pod,
	V1PodStatus,
} from "../../client";
import { Channel, select } from "../../go/channel";
import * as context from "../../go/context";
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
import { buildContainerID, PodStatusCache } from "./container";
import { PodManager } from "./pod";
import { ProbeManager } from "./prober";
import type { ProbeUpdate } from "./prober";
import { PodWorkers } from "./pod-workers";
import type { PodRuntimeStatus, RuntimePod } from "../cri";
import { retryConflicts } from "../../retry";
import { Server } from "../server";
import { PodStore } from "../storage";
import { EventRecorder } from "../events";
import {
	generateContainersReadyCondition,
	generatePodReadyCondition,
	StatusManager,
} from "./status";
import type { Watcher } from "../storage/watch";
import { ContainerDied, ContainerRemoved, GenericPLEG, type PodLifecycleEvent } from "./pleg";

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
	containersToStart: ContainerStartAction[];
	containersToKill: ContainerInstance[];
}

interface ContainerStartAction {
	container: V1Container;
	restartCount: number;
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

function isSyncPodWorthy(event: PodLifecycleEvent): boolean {
	return event.type !== ContainerRemoved;
}

export class Kubelet {
	server: Server;
	private readonly containerRuntime: Runtime;
	private readonly pods: PodStore;
	private readonly podManager: PodManager;
	private watcher: Watcher<V1Pod> | undefined;
	private readonly runningPods = new Map<string, RunningPod>();
	private readonly probeManager: ProbeManager;
	private readonly podWorkers: PodWorkers;
	private readonly podCache = new PodStatusCache();
	private readonly pleg: GenericPLEG;
	private readonly statusManager: StatusManager;
	private readonly events: EventRecorder;
	private readonly podUpdates = new Channel<PodUpdate>(50);
	private ctx: context.Context | undefined;
	private cancelContext: context.CancelFunc | undefined;
	private syncLoopPromise: Promise<void> | undefined;
	private statusManagerPromise: Promise<void> | undefined;
	private closePromise: Promise<void> | undefined;
	private syncLoopExited = false;
	private stopped = false;

	public constructor(server: Server) {
		this.server = server;
		this.containerRuntime = server.runtime;
		this.pods = new PodStore(server.cluster.etcd);
		this.podManager = new PodManager();
		this.events = new EventRecorder({
			api: server.cluster.kubeConfig.makeApiClient(CoreV1Api),
			clock: server.cluster.clock,
			component: "kubelet",
			host: server.name,
		});
		this.statusManager = new StatusManager({
			clock: server.cluster.clock,
			kubeClient: server.cluster.api,
			podManager: this.podManager,
		});
		this.probeManager = new ProbeManager({
			clock: server.cluster.clock,
			runtime: this.containerRuntime,
			statusManager: this.statusManager,
		});
		this.pleg = new GenericPLEG(
			this.containerRuntime,
			new Channel<PodLifecycleEvent>(100),
			{
				relistPeriodMs: 1000,
				relistThresholdMs: 3 * 60 * 1000,
			},
			this.podCache,
			server.cluster.clock,
		);
		this.podWorkers = new PodWorkers(
			server.cluster.clock,
			(ctx, pod, podStatus) => this.syncPod(ctx, pod, podStatus),
			(ctx, podUID, minTime) => this.getPodStatusFromCache(ctx, podUID, minTime),
			(ctx, pod, podStatus, gracePeriod, podStatusFn) =>
				this.syncTerminatingPod(ctx, pod, podStatus, gracePeriod, podStatusFn),
			(ctx, pod, podStatus) => this.syncTerminatedPod(ctx, pod, podStatus),
		);
	}

	async start(ctx: context.Context): Promise<void> {
		[this.ctx, this.cancelContext] = context.withCancel(ctx);
		this.statusManagerPromise = this.statusManager.start(this.ctx);
		this.pleg.start();
		this.syncLoopPromise = this.syncLoop(this.ctx);
		await this.reconcileExistingPods(this.ctx);
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

	close(): Promise<void> {
		if (!this.closePromise) {
			this.stopped = true;
			this.cancelContext?.();
			this.closePromise = (async () => {
				await this.watcher?.cancel();
				await this.pleg.stop();
				this.podCache.updateTime(this.server.cluster.clock.now());
				await this.probeManager.close();
				await this.podWorkers.close();
				await this.containerRuntime.close();
				this.runningPods.clear();
				await this.syncLoopPromise;
				await this.statusManagerPromise;
			})();
		}
		return this.closePromise;
	}

	isSyncLoopExited(): boolean {
		return this.syncLoopExited;
	}

	probeWorkerCount(): number {
		return this.probeManager.workerCount();
	}

	async probeResultChannelsAreOpen(): Promise<boolean> {
		for (const updates of [
			this.probeManager.livenessManager.updates(),
			this.probeManager.readinessManager.updates(),
			this.probeManager.startupManager.updates(),
		]) {
			const open = await select()
				.case(updates, ({ ok }) => ok)
				.default(() => true);
			if (!open) {
				return false;
			}
		}
		return true;
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
	private async syncLoop(ctx: context.Context): Promise<void> {
		try {
			await this.syncLoopIteration(ctx);
		} finally {
			this.syncLoopExited = true;
		}
	}

	private async syncLoopIteration(ctx: context.Context): Promise<void> {
		const plegCh = this.pleg.watch();
		while (!this.stopped && !ctx.err()) {
			const selected = await select()
				.case(ctx.done(), () => "done")
				.case(plegCh, async ({ ok, value }) => {
					if (!ok) {
						return "closed";
					}
					await this.handlePlegEvent(ctx, value);
					return "handled";
				})
				.case(this.podUpdates, async ({ ok, value }) => {
					if (!ok) {
						return "closed";
					}
					await this.handlePodUpdate(ctx, value);
					return "handled";
				})
				.case(this.probeManager.livenessManager.updates(), async ({ ok, value }) => {
					if (!ok) {
						return "closed";
					}
					if (value.result === "failure") {
						await this.handleProbeSync(ctx, value, "liveness", "unhealthy");
					}
					return "handled";
				})
				.case(this.probeManager.readinessManager.updates(), async ({ ok, value }) => {
					if (!ok) {
						return "closed";
					}
					const ready = value.result === "success";
					this.statusManager.setContainerReadiness(value.podUid, value.containerId, ready);

					const status = ready ? "ready" : "not ready";
					await this.handleProbeSync(ctx, value, "readiness", status);
					return "handled";
				})
				.case(this.probeManager.startupManager.updates(), async ({ ok, value }) => {
					if (!ok) {
						return "closed";
					}
					const started = value.result === "success";
					this.statusManager.setContainerStartup(value.podUid, value.containerId, started);

					const status = started ? "started" : "unhealthy";
					await this.handleProbeSync(ctx, value, "startup", status);
					return "handled";
				});
			if (selected === "closed" || selected === "done") {
				return;
			}
		}
	}

	private async handlePodUpdate(ctx: context.Context, update: PodUpdate): Promise<void> {
		switch (update.op) {
			case "ADD":
				this.handlePodAdditions(ctx, update.pods);
				return;
			case "UPDATE":
				this.handlePodUpdates(ctx, update.pods);
				return;
			case "DELETE":
				for (const pod of update.pods) {
					this.podManager.removePod(pod);
					await this.deletePodStatus(pod);
				}
				return;
		}
	}

	private async handlePlegEvent(ctx: context.Context, event: PodLifecycleEvent): Promise<void> {
		if (isSyncPodWorthy(event)) {
			const pod = this.podManager.getPodByUid(event.id);
			if (pod) {
				this.handlePodSyncs(ctx, [pod]);
			}
		}
		if (event.type === ContainerDied && event.data) {
			await this.cleanUpContainersInPod(event.id, event.data);
		}
	}

	// Models kubernetes/pkg/kubelet/kubelet.go handleProbeSync.
	private async handleProbeSync(
		ctx: context.Context,
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
		const pod = this.podManager.getPodByUid(update.podUid);
		if (!pod) {
			return;
		}
		this.handlePodSyncs(ctx, [pod]);
	}

	private async reconcileExistingPods(ctx: context.Context): Promise<void> {
		const pods = (await this.pods.list()).filter(
			(pod) => pod.spec?.nodeName === this.server.name && pod.metadata?.name,
		);
		this.podManager.setPods(pods);
		this.handlePodSyncs(ctx, pods);
	}

	// Models kubernetes/pkg/kubelet/kubelet.go HandlePodAdditions.
	private handlePodAdditions(ctx: context.Context, pods: V1Pod[]): void {
		const start = this.server.cluster.clock.now();
		for (const pod of pods) {
			if (this.stopped || pod.spec?.nodeName !== this.server.name || !pod.metadata?.name) {
				continue;
			}
			// Always add the pod to the pod manager. Kubelet relies on the pod
			// manager as the source of truth for the desired state.
			this.podManager.addPod(pod);
			const { pod: resolvedPod } = this.podManager.getPodAndMirrorPod(pod);
			if (!resolvedPod) {
				continue;
			}
			this.podWorkers.updatePod(ctx, {
				pod: resolvedPod,
				updateType: "create",
				startTime: start,
			});
		}
	}

	// Models kubernetes/pkg/kubelet/kubelet.go HandlePodUpdates.
	private handlePodUpdates(ctx: context.Context, pods: V1Pod[]): void {
		const start = this.server.cluster.clock.now();
		for (const pod of pods) {
			if (this.stopped || pod.spec?.nodeName !== this.server.name || !pod.metadata?.name) {
				continue;
			}
			this.podManager.updatePod(pod);
			const { pod: resolvedPod } = this.podManager.getPodAndMirrorPod(pod);
			if (!resolvedPod) {
				continue;
			}
			this.podWorkers.updatePod(ctx, {
				pod: resolvedPod,
				updateType: "update",
				startTime: start,
			});
		}
	}

	// Models kubernetes/pkg/kubelet/kubelet.go HandlePodSyncs.
	private handlePodSyncs(ctx: context.Context, pods: V1Pod[]): void {
		const start = this.server.cluster.clock.now();
		for (const pod of pods) {
			if (this.stopped || pod.spec?.nodeName !== this.server.name || !pod.metadata?.name) {
				continue;
			}
			const { pod: resolvedPod } = this.podManager.getPodAndMirrorPod(pod);
			if (!resolvedPod) {
				continue;
			}
			this.podWorkers.updatePod(ctx, {
				pod: resolvedPod,
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
		this.statusManager.removeOrphanedStatuses(
			new Set(
				this.podManager
					.getPods()
					.map((pod) => pod.metadata?.uid)
					.filter((uid): uid is string => uid !== undefined),
			),
		);
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

	private async syncPod(
		ctx: context.Context,
		pod: V1Pod,
		_podStatus: PodRuntimeStatus,
	): Promise<void> {
		if (ctx.err()) {
			return;
		}
		this.probeManager.addPod(ctx, pod);
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
		for (const action of actions.containersToStart) {
			await this.startContainer(
				pod,
				running.sandboxId,
				sandboxConfig,
				action.container,
				action.restartCount,
			);
		}

		await this.updatePodStatus(pod, running.sandboxId, sandboxStatus);
	}

	// Models kubernetes/pkg/kubelet/kubelet.go SyncTerminatingPod.
	private async syncTerminatingPod(
		ctx: context.Context,
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
		gracePeriod: number | undefined,
		podStatusFn: ((status: V1PodStatus) => void) | undefined,
	): Promise<void> {
		const apiPodStatus = this.generateAPIPodStatus(pod, podStatus, false);
		podStatusFn?.(apiPodStatus);
		await this.statusManager.setPodStatus(pod, apiPodStatus);

		this.probeManager.stopLivenessAndStartup(pod);

		await this.killPod(ctx, pod, gracePeriod);

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
	private async syncTerminatedPod(
		ctx: context.Context,
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
	): Promise<void> {
		if (ctx.err()) {
			throw context.Canceled;
		}
		const apiPodStatus = this.generateAPIPodStatus(pod, podStatus, true);
		await this.statusManager.setPodStatus(pod, apiPodStatus);

		// Kubernetes waits for volume teardown, unregisters secret/configmap
		// managers, and releases cgroups/user namespaces here. The simulator does
		// not model those resources, but it does tear down its in-memory CRI pod.
		await this.cleanupPodRuntime(pod);

		await this.statusManager.terminatePod(pod);
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go killPod.
	private async killPod(
		ctx: context.Context,
		pod: V1Pod,
		gracePeriod: number | undefined,
	): Promise<void> {
		const key = podKey(pod);
		const running = this.runningPods.get(key);
		if (running) {
			const sandbox = this.containerRuntime.getPodSandbox(running.sandboxId);
			if (gracePeriod !== undefined) {
				await this.waitWithContext(ctx, gracePeriod * 1000);
			}
			for (const container of sandbox?.containers.values() ?? []) {
				await this.events.event(pod, "Normal", "Killing", `Stopping container ${container.name}`);
				await this.containerRuntime.stopContainer(container.id, gracePeriod);
			}
			sandbox?.unregisterNetwork();
			sandbox?.setReady(false);
		}
	}

	private async waitWithContext(ctx: context.Context, ms: number): Promise<void> {
		if (ctx.err()) {
			throw context.Canceled;
		}
		const timeoutCh = new Channel<void>(1);
		const handle = this.server.cluster.clock.setTimeout(() => {
			timeoutCh.trySend(undefined);
		}, ms);
		try {
			const selected = await select()
				.case(ctx.done(), () => "done" as const)
				.case(timeoutCh, () => "timeout" as const);
			if (selected === "done") {
				throw context.Canceled;
			}
		} finally {
			this.server.cluster.clock.clearTimeout(handle);
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
			timestamp: this.server.cluster.clock.now(),
			containers: [],
			sandboxes: [],
			containerStatuses: [],
			sandboxStatuses: [],
		};
	}

	private async getPodStatusFromCache(
		ctx: context.Context,
		podUID: string,
		minTime: Date,
	): Promise<PodRuntimeStatus> {
		const canceled = { canceled: true } as const;
		const status = this.podCache.getNewerThan(podUID, minTime);
		const result = await Promise.race([
			status,
			ctx
				.done()
				.receive()
				.then(() => canceled),
		]);
		if ("canceled" in result) {
			throw context.Canceled;
		}
		if (result.error) {
			throw result.error;
		}
		return result.status;
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
			actions.containersToStart = containers
				.filter((container) => this.shouldStartInFreshSandbox(pod, container))
				.map((container) => this.containerStartAction(pod, container, undefined));
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
					actions.containersToStart.push(this.containerStartAction(pod, spec, undefined));
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
						actions.containersToStart.push(this.containerStartAction(pod, spec, status));
					}
				}
				continue;
			}

			if (status.state === "Created" || this.shouldRestartMissingOrExited(pod, spec, status)) {
				actions.containersToKill.push(current);
				actions.containersToStart.push(this.containerStartAction(pod, spec, status));
			}
		}

		const keptRunning = [...sandbox.containers.values()].some(
			(container) =>
				!actions.containersToKill.includes(container) && container.status().state === "Running",
		);
		if (!keptRunning && actions.containersToStart.length === 0 && pod.metadata?.deletionTimestamp) {
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
			id: pod.metadata?.uid ?? "",
			ip: sandbox.network?.ip,
			ips: sandbox.network?.ip ? [sandbox.network.ip] : [],
			containerStatuses: [...(runtimeSandbox?.containers.values() ?? [])].map((container) =>
				this.containerRuntime.containerStatus(container.id),
			),
			sandboxStatuses: runtimeSandbox ? [runtimeSandbox.status()] : [],
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
		const status = this.convertStatusToAPIStatus(pod, podStatus, currentStatus, podIsTerminal);
		if (
			status.phase !== "Failed" &&
			status.phase !== "Succeeded" &&
			(currentStatus?.phase === "Failed" || currentStatus?.phase === "Succeeded")
		) {
			status.phase = currentStatus.phase;
		}
		this.probeManager.updatePodStatus(pod, status);
		const conditions = (status.conditions ?? []).filter(
			(condition) => condition.type !== "Ready" && condition.type !== "ContainersReady",
		);
		const allContainerStatuses = status.containerStatuses ?? [];
		status.conditions = [
			...conditions,
			generatePodReadyCondition(pod, status, conditions, allContainerStatuses, status.phase),
			generateContainersReadyCondition(pod, status, allContainerStatuses, status.phase),
		];
		return status;
	}

	// Models kubernetes/pkg/kubelet/kubelet_pods.go convertStatusToAPIStatus.
	private convertStatusToAPIStatus(
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
		currentStatus: V1PodStatus | undefined,
		podIsTerminal: boolean,
	): V1PodStatus {
		const containerStatuses = podStatus.containerStatuses.map((status) =>
			this.podContainerStatus(status),
		);
		const byName = new Map(containerStatuses.map((status) => [status.name, status]));
		const orderedStatuses = (pod.spec?.containers ?? [])
			.map((container) => byName.get(container.name))
			.filter((status): status is V1ContainerStatus => status !== undefined);
		return {
			...currentStatus,
			phase: this.podPhase(pod, orderedStatuses, podIsTerminal),
			podIP: podStatus.ip,
			podIPs: podStatus.ip ? [{ ip: podStatus.ip }] : undefined,
			containerStatuses: orderedStatuses,
		};
	}

	// Models the regular-container portion of kubernetes/pkg/kubelet/kubelet_pods.go getPhase.
	// The simulator does not model init containers or container-level restart rules.
	private podPhase(
		pod: V1Pod,
		containerStatuses: V1ContainerStatus[],
		podIsTerminal: boolean,
	): NonNullable<V1PodStatus["phase"]> {
		let unknown = Math.max(0, (pod.spec?.containers ?? []).length - containerStatuses.length);
		let running = 0;
		let waiting = 0;
		let stopped = 0;
		let succeeded = 0;

		for (const status of containerStatuses) {
			if (status.state?.running) {
				running++;
				continue;
			}
			if (status.state?.terminated) {
				stopped++;
				if (status.state.terminated.exitCode === 0) {
					succeeded++;
				}
				continue;
			}
			if (status.state?.waiting) {
				waiting++;
				continue;
			}
			unknown++;
		}

		if (waiting > 0) {
			return "Pending";
		}
		if (running > 0 && unknown === 0) {
			return "Running";
		}
		if (running === 0 && stopped > 0 && unknown === 0) {
			if (podIsTerminal) {
				return stopped === succeeded ? "Succeeded" : "Failed";
			}
			if ((pod.spec?.restartPolicy ?? "Always") === "Always") {
				return "Running";
			}
			if (stopped === succeeded) {
				return "Succeeded";
			}
			if (pod.spec?.restartPolicy === "Never") {
				return "Failed";
			}
			return "Running";
		}
		return "Pending";
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
			this.probeManager.livenessManager.get(id) === "failure" ||
			this.probeManager.startupManager.get(id) === "failure"
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

	private containerStartAction(
		pod: V1Pod,
		container: V1Container,
		status: ContainerStatus | undefined,
	): ContainerStartAction {
		if (status) {
			return {
				container,
				restartCount: status.state === "Created" ? status.restartCount : status.restartCount + 1,
			};
		}
		const previous = this.previousContainerStatus(pod, container.name);
		return {
			container,
			restartCount: previous ? previous.restartCount + 1 : 0,
		};
	}

	private async cleanUpContainersInPod(podID: string, exitedContainerID: string): Promise<void> {
		const podStatus = this.podCache.get(podID);
		if (podStatus.error) {
			return;
		}
		await this.containerRuntime.deleteContainersInPod(
			exitedContainerID,
			podStatus.status,
			false,
			1,
		);
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
}
