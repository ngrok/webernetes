import * as k8s from "../../client";
import { isNotFoundError } from "../../client/errors";
import type { Clock } from "../../clock";
import { retryConflicts } from "../../retry";
import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

export interface EndpointSliceControllerOptions {
	kubeConfig: k8s.KubeConfig;
}

export class EndpointSliceController extends BaseImage {
	private readonly coreApi: k8s.CoreV1Api;
	private readonly discoveryApi: k8s.DiscoveryV1Api;
	private serviceInformer: k8s.Informer<k8s.V1Service> | undefined;
	private podInformer: k8s.Informer<k8s.V1Pod> | undefined;
	private readonly services = new Map<string, k8s.V1Service>();
	private readonly servicesByNamespace = new Map<string, Set<string>>();
	private readonly pods = new Map<string, k8s.V1Pod>();
	private readonly podsByNamespace = new Map<string, Set<string>>();
	private readonly pending = new Set<string>();
	private readonly requeued = new Set<string>();
	private clock: Clock | undefined;

	constructor(private readonly options: EndpointSliceControllerOptions) {
		super();
		this.coreApi = options.kubeConfig.makeApiClient(k8s.CoreV1Api);
		this.discoveryApi = options.kubeConfig.makeApiClient(k8s.DiscoveryV1Api);
	}

	async start(context: ProcessContext, _argv: readonly string[]): Promise<number> {
		this.clock = context.clock;
		await this.startInformers();
		try {
			return await context.waitUntilKilled();
		} finally {
			await this.close();
		}
	}

	private async close(): Promise<void> {
		await this.serviceInformer?.stop();
		await this.podInformer?.stop();
	}

	private async startInformers(): Promise<void> {
		this.serviceInformer = k8s.makeInformer(
			this.options.kubeConfig,
			"/api/v1/services",
			async () => await this.coreApi.listServiceForAllNamespaces(),
		);
		this.podInformer = k8s.makeInformer(
			this.options.kubeConfig,
			"/api/v1/pods",
			async () => await this.coreApi.listPodForAllNamespaces(),
		);
		this.serviceInformer.on("add", (service) => this.upsertService(service));
		this.serviceInformer.on("update", (service) => this.upsertService(service));
		this.serviceInformer.on("delete", (service) => this.deleteService(service));
		this.podInformer.on("add", (pod) => this.upsertPod(pod));
		this.podInformer.on("update", (pod) => this.upsertPod(pod));
		this.podInformer.on("delete", (pod) => this.deletePod(pod));

		await this.serviceInformer.start();
		await this.podInformer.start();
		for (const service of this.services.values()) {
			this.queueServiceReconcile(service);
		}
	}

	private upsertService(service: k8s.V1Service): void {
		const key = serviceKey(service);
		const previous = this.services.get(key);
		if (previous) {
			this.unindexService(previous);
		}
		this.services.set(key, service);
		this.indexService(service);
		this.queueServiceReconcile(service);
	}

	private deleteService(service: k8s.V1Service): void {
		const key = serviceKey(service);
		const stored = this.services.get(key) ?? service;
		this.unindexService(stored);
		this.services.delete(key);
		void this.deleteGeneratedSlice(stored).catch(() => undefined);
	}

	private upsertPod(pod: k8s.V1Pod): void {
		const key = podKey(pod);
		const previous = this.pods.get(key);
		if (previous) {
			this.unindexPod(previous);
		}
		this.pods.set(key, pod);
		this.indexPod(pod);
		this.queueServicesInNamespace(pod.metadata?.namespace ?? "default");
	}

	private deletePod(pod: k8s.V1Pod): void {
		const key = podKey(pod);
		const stored = this.pods.get(key) ?? pod;
		this.unindexPod(stored);
		this.pods.delete(key);
		this.queueServicesInNamespace(pod.metadata?.namespace ?? "default");
	}

	private queueServicesInNamespace(namespace: string): void {
		for (const key of this.servicesByNamespace.get(namespace) ?? []) {
			const service = this.services.get(key);
			if (service) {
				this.queueServiceReconcile(service);
			}
		}
	}

	private queueServiceReconcile(service: k8s.V1Service): void {
		const key = serviceKey(service);
		if (this.pending.has(key)) {
			this.requeued.add(key);
			return;
		}
		this.pending.add(key);
		void this.reconcileService(service)
			.catch(() => undefined)
			.finally(() => {
				this.pending.delete(key);
				if (this.requeued.delete(key)) {
					const latest = this.services.get(key);
					if (latest) {
						this.queueServiceReconcile(latest);
					}
				}
			});
	}

	private async reconcileService(service: k8s.V1Service): Promise<void> {
		const name = service.metadata?.name;
		const namespace = service.metadata?.namespace ?? "default";
		const selector = new Map(Object.entries(service.spec?.selector ?? {}));
		if (!name || selector.size === 0 || service.spec?.type === "ExternalName") {
			await this.deleteGeneratedSlice(service);
			return;
		}

		const matchingPods = [...(this.podsByNamespace.get(namespace) ?? [])]
			.map((key) => this.pods.get(key))
			.filter((pod): pod is k8s.V1Pod => pod !== undefined)
			.filter((pod) => labelsMatch(selector, new Map(Object.entries(pod.metadata?.labels ?? {}))))
			.filter((pod) => pod.status?.podIP);
		const slice = this.endpointSliceForService(service, matchingPods);
		await this.applyEndpointSlice(slice);
	}

	private endpointSliceForService(service: k8s.V1Service, pods: k8s.V1Pod[]): k8s.V1EndpointSlice {
		const namespace = service.metadata?.namespace ?? "default";
		const name = service.metadata?.name ?? "";
		return {
			apiVersion: "discovery.k8s.io/v1",
			kind: "EndpointSlice",
			addressType: "IPv4",
			metadata: {
				name: generatedSliceName(name),
				namespace,
				labels: {
					"kubernetes.io/service-name": name,
					"endpointslice.kubernetes.io/managed-by": "k8s-web-simulator",
				},
			},
			ports:
				pods.length === 0
					? []
					: (service.spec?.ports ?? []).flatMap((port) => {
							const endpointPort = resolveEndpointPort(port.targetPort ?? port.port, pods);
							return endpointPort === undefined
								? []
								: [
										{
											name: port.name,
											port: endpointPort,
											protocol: port.protocol ?? "TCP",
										},
									];
						}),
			endpoints: pods.flatMap((pod) => {
				const podIp = pod.status?.podIP;
				if (!podIp) {
					return [];
				}
				const ready = isReadyPod(pod);
				return [
					{
						addresses: [podIp],
						conditions: {
							ready,
							serving: ready,
							terminating: false,
						},
						nodeName: pod.spec?.nodeName,
						targetRef: {
							apiVersion: "v1",
							kind: "Pod",
							name: pod.metadata?.name,
							namespace,
							uid: pod.metadata?.uid,
						},
					},
				];
			}),
		};
	}

	private async applyEndpointSlice(slice: k8s.V1EndpointSlice): Promise<void> {
		const clock = this.clock;
		if (!clock) {
			throw new Error("EndpointSliceController has not started");
		}
		const name = slice.metadata?.name ?? "";
		const namespace = slice.metadata?.namespace ?? "default";
		try {
			await retryConflicts(
				async () => {
					try {
						const current = await this.discoveryApi.readNamespacedEndpointSlice({
							name,
							namespace,
						});
						await this.discoveryApi.replaceNamespacedEndpointSlice({
							name,
							namespace,
							body: {
								...slice,
								metadata: {
									...slice.metadata,
									resourceVersion: current.metadata?.resourceVersion,
								},
							},
						});
					} catch (error) {
						if (!isNotFoundError(error)) {
							throw error;
						}
						await this.discoveryApi.createNamespacedEndpointSlice({ namespace, body: slice });
					}
				},
				{ clock },
			);
		} catch (error) {
			if (!isNotFoundError(error)) {
				throw error;
			}
		}
	}

	private async deleteGeneratedSlice(service: k8s.V1Service): Promise<void> {
		const name = service.metadata?.name;
		if (!name) {
			return;
		}
		try {
			await this.discoveryApi.deleteNamespacedEndpointSlice({
				name: generatedSliceName(name),
				namespace: service.metadata?.namespace ?? "default",
			});
		} catch (error) {
			if (!isNotFoundError(error)) {
				throw error;
			}
		}
	}

	private indexService(service: k8s.V1Service): void {
		addToNamespaceIndex(
			this.servicesByNamespace,
			service.metadata?.namespace ?? "default",
			serviceKey(service),
		);
	}

	private unindexService(service: k8s.V1Service): void {
		removeFromNamespaceIndex(
			this.servicesByNamespace,
			service.metadata?.namespace ?? "default",
			serviceKey(service),
		);
	}

	private indexPod(pod: k8s.V1Pod): void {
		addToNamespaceIndex(this.podsByNamespace, pod.metadata?.namespace ?? "default", podKey(pod));
	}

	private unindexPod(pod: k8s.V1Pod): void {
		removeFromNamespaceIndex(
			this.podsByNamespace,
			pod.metadata?.namespace ?? "default",
			podKey(pod),
		);
	}
}

function generatedSliceName(serviceName: string): string {
	return `${serviceName}-simulator`;
}

function serviceKey(service: k8s.V1Service): string {
	return `${service.metadata?.namespace ?? "default"}/${service.metadata?.name ?? ""}`;
}

function podKey(pod: k8s.V1Pod): string {
	return `${pod.metadata?.namespace ?? "default"}/${pod.metadata?.name ?? ""}`;
}

function addToNamespaceIndex(
	index: Map<string, Set<string>>,
	namespace: string,
	key: string,
): void {
	let keys = index.get(namespace);
	if (!keys) {
		keys = new Set();
		index.set(namespace, keys);
	}
	keys.add(key);
}

function removeFromNamespaceIndex(
	index: Map<string, Set<string>>,
	namespace: string,
	key: string,
): void {
	const keys = index.get(namespace);
	if (!keys) {
		return;
	}
	keys.delete(key);
	if (keys.size === 0) {
		index.delete(namespace);
	}
}

function isReadyPod(pod: k8s.V1Pod): boolean {
	if (pod.status?.phase !== "Running" || !pod.status.podIP) {
		return false;
	}
	const statuses = pod.status.containerStatuses ?? [];
	return statuses.length > 0 && statuses.every((status) => status.ready);
}

function labelsMatch(
	selector: ReadonlyMap<string, string>,
	labels: ReadonlyMap<string, string>,
): boolean {
	for (const [key, value] of selector) {
		if (labels.get(key) !== value) {
			return false;
		}
	}
	return true;
}

function resolveEndpointPort(
	targetPort: number | string,
	pods: readonly k8s.V1Pod[],
): number | undefined {
	if (typeof targetPort === "number") {
		return targetPort;
	}
	for (const pod of pods) {
		for (const container of pod.spec?.containers ?? []) {
			const match = container.ports?.find((containerPort) => containerPort.name === targetPort);
			if (match) {
				return match.containerPort;
			}
		}
	}
	return undefined;
}
