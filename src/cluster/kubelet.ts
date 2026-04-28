import type {
	V1Container,
	V1ContainerState,
	V1ContainerStatus,
	V1Pod,
	V1PodStatus,
} from "../client";
import type { ContainerConfig, ContainerPort, ContainerStatus, PodSandboxConfig } from "./cri";
import { Server } from "./server";
import { PodStore } from "./storage";
import type { Watcher } from "./storage/watch";

interface RunningPod {
	sandboxId: string;
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

function currentContainerReady(status: V1PodStatus | undefined, name: string): boolean | undefined {
	return status?.containerStatuses?.find((container) => container.name === name)?.ready;
}

function currentConditionStatus(status: V1PodStatus | undefined, type: string): string | undefined {
	return status?.conditions?.find((condition) => condition.type === type)?.status;
}

export class Kubelet {
	server: Server;
	private readonly pods: PodStore;
	private watcher: Watcher<V1Pod> | undefined;
	private readonly runningPods = new Map<string, RunningPod>();
	private readonly pending = new Set<string>();
	private stopped = false;

	public constructor(server: Server) {
		this.server = server;
		this.pods = new PodStore(server.cluster.etcd);
	}

	async start(): Promise<void> {
		await this.reconcileExistingPods();
		this.watcher = await this.pods.watch();
		this.watcher.on("event", (event, pod) => {
			if (event === "DELETED") {
				this.deletePod(pod);
				return;
			}
			this.reconcilePod(pod);
		});
	}

	close(): void {
		this.stopped = true;
		void this.watcher?.cancel();
		for (const pod of this.runningPods.values()) {
			void this.server.runtime.removePodSandbox(pod.sandboxId);
		}
		this.runningPods.clear();
	}

	private async reconcileExistingPods(): Promise<void> {
		for (const pod of await this.pods.list()) {
			this.reconcilePod(pod);
		}
	}

	private reconcilePod(pod: V1Pod): void {
		if (this.stopped || pod.spec?.nodeName !== this.server.name || !pod.metadata?.name) {
			return;
		}
		const key = podKey(pod);
		if (this.pending.has(key)) {
			return;
		}
		this.pending.add(key);
		void this.syncPod(pod)
			.catch(() => undefined)
			.finally(() => this.pending.delete(key));
	}

	private deletePod(pod: V1Pod): void {
		const key = podKey(pod);
		const running = this.runningPods.get(key);
		if (!running) {
			return;
		}
		this.runningPods.delete(key);
		void this.server.runtime.removePodSandbox(running.sandboxId);
	}

	private async syncPod(pod: V1Pod): Promise<void> {
		const key = podKey(pod);
		const existing = this.runningPods.get(key);
		if (existing) {
			await this.updatePodStatus(pod, existing.sandboxId);
			return;
		}

		const sandboxConfig = this.podSandboxConfig(pod);
		const sandboxId = await this.server.runtime.runPodSandbox(sandboxConfig);
		this.runningPods.set(key, { sandboxId });

		for (const container of pod.spec?.containers ?? []) {
			const containerId = await this.server.runtime.createContainer(
				sandboxId,
				this.containerConfig(container),
				sandboxConfig,
			);
			await this.server.runtime.startContainer(containerId);
		}

		await this.updatePodStatus(pod, sandboxId);
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
				servers: [],
				searches: [`${namespace}.svc.cluster.local`, "svc.cluster.local", "cluster.local"],
				options: ["ndots:5"],
			},
			labels: pod.metadata?.labels,
			annotations: pod.metadata?.annotations,
		};
	}

	private containerConfig(container: V1Container): ContainerConfig {
		return {
			metadata: {
				name: container.name,
				attempt: 0,
			},
			image: {
				image: container.image ?? "",
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

	private async updatePodStatus(pod: V1Pod, sandboxId: string): Promise<void> {
		const name = pod.metadata?.name;
		const namespace = pod.metadata?.namespace;
		if (!name) {
			return;
		}
		const sandbox = this.server.runtime.podSandboxStatus(sandboxId);
		const containers = this.server.runtime.getPodSandbox(sandboxId)
			? [...(this.server.runtime.getPodSandbox(sandboxId)?.containers.values() ?? [])]
			: [];
		const containerStatuses = containers.map((container) =>
			this.podContainerStatus(this.server.runtime.containerStatus(container.id)),
		);
		for (let attempt = 0; attempt < 5; attempt++) {
			const current = await this.pods.get(name, namespace);
			if (!current) {
				return;
			}
			current.status = this.podStatus(sandbox.network?.ip, containerStatuses, current.status);
			try {
				await this.pods.update(name, current);
				return;
			} catch (error) {
				if (error instanceof Error && error.name === "Conflict") {
					continue;
				}
				throw error;
			}
		}
	}

	private podStatus(
		podIP: string | undefined,
		containerStatuses: V1ContainerStatus[],
		currentStatus: V1PodStatus | undefined,
	): V1PodStatus {
		const running = containerStatuses.some((status) => status.state?.running);
		const terminated = containerStatuses.some((status) => status.state?.terminated);
		const statuses = containerStatuses.map((status) => ({
			...status,
			ready: currentContainerReady(currentStatus, status.name) ?? status.ready,
		}));
		const allReady = statuses.length > 0 && statuses.every((status) => status.ready);
		return {
			phase: running ? "Running" : terminated ? "Failed" : "Pending",
			podIP,
			podIPs: podIP ? [{ ip: podIP }] : undefined,
			containerStatuses: statuses,
			conditions: [
				{
					type: "Ready",
					status: currentConditionStatus(currentStatus, "Ready") ?? (allReady ? "True" : "False"),
				},
				{
					type: "ContainersReady",
					status:
						currentConditionStatus(currentStatus, "ContainersReady") ??
						(allReady ? "True" : "False"),
				},
			],
		};
	}

	private podContainerStatus(status: ContainerStatus): V1ContainerStatus {
		return {
			name: status.name,
			image: status.imageRef,
			imageID: status.imageRef,
			containerID: `simulator://${status.id}`,
			ready: status.ready,
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
						containerID: `simulator://${status.id}`,
					},
				};
			case "Created":
				return { waiting: { reason: "ContainerCreating" } };
		}
	}
}
