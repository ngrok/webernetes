import * as k8s from "../../client";
import { isNotFoundError } from "../../client/errors";
import { deepEqual } from "../../deep-equal";
import { retryConflicts } from "../../retry";
import { isPodReadyConditionTrue } from "../api/v1/pod/util";
import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

const controllerName = "endpointslice-controller.k8s.io";
const labelServiceName = "kubernetes.io/service-name";
const labelManagedBy = "endpointslice.kubernetes.io/managed-by";
const labelHeadlessService = "service.kubernetes.io/headless";

// TODO(samwho): rewrite this to extract the endpoint slice controller out and
// make it have parity with the upstream endpoint slice controller.
export class EndpointSliceController extends BaseImage {
	static readonly imageName = "webernetes/endpointslice-controller";
	static readonly imageVersion = "1.0";

	readonly defaultCommand = ["endpointslice-controller"];
	private serviceInformer: k8s.Informer<k8s.V1Service> | undefined;
	private podInformer: k8s.Informer<k8s.V1Pod> | undefined;
	private endpointSliceInformer: k8s.Informer<k8s.V1EndpointSlice> | undefined;
	private readonly services = new Map<string, k8s.V1Service>();
	private readonly servicesByNamespace = new Map<string, Set<string>>();
	private readonly pods = new Map<string, k8s.V1Pod>();
	private readonly podsByNamespace = new Map<string, Set<string>>();
	private readonly endpointSlices = new Map<string, k8s.V1EndpointSlice>();
	private readonly pending = new Set<string>();
	private readonly requeued = new Set<string>();

	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "endpointslice-controller") {
			return await super.exec(ctx, argv);
		}
		await this.startInformers(ctx);
		try {
			return await ctx.waitUntilKilled();
		} finally {
			await this.close();
		}
	}

	private async close(): Promise<void> {
		await this.serviceInformer?.stop();
		await this.podInformer?.stop();
		await this.endpointSliceInformer?.stop();
	}

	private async startInformers(ctx: ProcessContext): Promise<void> {
		this.serviceInformer = k8s.makeInformer(
			ctx.kubeConfig,
			"/api/v1/services",
			async () => await ctx.api.corev1.listServiceForAllNamespaces(),
		);
		this.podInformer = k8s.makeInformer(
			ctx.kubeConfig,
			"/api/v1/pods",
			async () => await ctx.api.corev1.listPodForAllNamespaces(),
		);
		this.endpointSliceInformer = k8s.makeInformer(
			ctx.kubeConfig,
			"/apis/discovery.k8s.io/v1/endpointslices",
			async () => await ctx.api.discoveryv1.listEndpointSliceForAllNamespaces(),
		);
		this.serviceInformer.on("add", (service) => this.upsertService(ctx, service));
		this.serviceInformer.on("update", (service) => this.upsertService(ctx, service));
		this.serviceInformer.on("delete", (service) => this.deleteService(ctx, service));
		this.podInformer.on("add", (pod) => this.upsertPod(ctx, pod));
		this.podInformer.on("update", (pod) => this.upsertPod(ctx, pod));
		this.podInformer.on("delete", (pod) => this.deletePod(ctx, pod));
		this.endpointSliceInformer.on("add", (slice) => this.upsertEndpointSlice(ctx, slice));
		this.endpointSliceInformer.on("update", (slice) => this.upsertEndpointSlice(ctx, slice));
		this.endpointSliceInformer.on("delete", (slice) => this.deleteEndpointSlice(ctx, slice));

		await this.serviceInformer.start();
		await this.podInformer.start();
		await this.endpointSliceInformer.start();
		for (const service of this.services.values()) {
			this.queueServiceReconcile(ctx, service);
		}
	}

	private upsertService(ctx: ProcessContext, service: k8s.V1Service): void {
		const key = serviceKey(service);
		const previous = this.services.get(key);
		if (previous) {
			this.unindexService(previous);
		}
		this.services.set(key, service);
		this.indexService(service);
		this.queueServiceReconcile(ctx, service);
	}

	private deleteService(ctx: ProcessContext, service: k8s.V1Service): void {
		const key = serviceKey(service);
		const stored = this.services.get(key) ?? service;
		this.unindexService(stored);
		this.services.delete(key);
		if (stored.metadata?.deletionTimestamp || service.metadata?.deletionTimestamp) {
			return;
		}
		void this.deleteGeneratedSlice(ctx, stored).catch(() => undefined);
	}

	private upsertPod(ctx: ProcessContext, pod: k8s.V1Pod): void {
		const key = podKey(pod);
		const previous = this.pods.get(key);
		if (previous) {
			this.unindexPod(previous);
		}
		this.pods.set(key, pod);
		this.indexPod(pod);
		this.queueServicesInNamespace(ctx, pod.metadata?.namespace ?? "default");
	}

	private deletePod(ctx: ProcessContext, pod: k8s.V1Pod): void {
		const key = podKey(pod);
		const stored = this.pods.get(key) ?? pod;
		this.unindexPod(stored);
		this.pods.delete(key);
		this.queueServicesInNamespace(ctx, pod.metadata?.namespace ?? "default");
	}

	private upsertEndpointSlice(ctx: ProcessContext, slice: k8s.V1EndpointSlice): void {
		const key = endpointSliceKey(slice);
		if (slice.metadata?.deletionTimestamp) {
			this.endpointSlices.delete(key);
		} else {
			this.endpointSlices.set(key, slice);
		}
		const serviceName = slice.metadata?.labels?.[labelServiceName];
		const namespace = slice.metadata?.namespace ?? "default";
		const service = serviceName ? this.services.get(`${namespace}/${serviceName}`) : undefined;
		if (service) {
			this.queueServiceReconcile(ctx, service);
		}
	}

	private deleteEndpointSlice(ctx: ProcessContext, slice: k8s.V1EndpointSlice): void {
		this.endpointSlices.delete(endpointSliceKey(slice));
		const serviceName = slice.metadata?.labels?.[labelServiceName];
		const namespace = slice.metadata?.namespace ?? "default";
		const service = serviceName ? this.services.get(`${namespace}/${serviceName}`) : undefined;
		if (service) {
			this.queueServiceReconcile(ctx, service);
		}
	}

	private queueServicesInNamespace(ctx: ProcessContext, namespace: string): void {
		for (const key of this.servicesByNamespace.get(namespace) ?? []) {
			const service = this.services.get(key);
			if (service) {
				this.queueServiceReconcile(ctx, service);
			}
		}
	}

	private queueServiceReconcile(ctx: ProcessContext, service: k8s.V1Service): void {
		const key = serviceKey(service);
		if (this.pending.has(key)) {
			this.requeued.add(key);
			return;
		}
		this.pending.add(key);
		void this.reconcileService(ctx, service)
			.catch(() => undefined)
			.finally(() => {
				this.pending.delete(key);
				if (this.requeued.delete(key)) {
					const latest = this.services.get(key);
					if (latest) {
						this.queueServiceReconcile(ctx, latest);
					}
				}
			});
	}

	private async reconcileService(ctx: ProcessContext, service: k8s.V1Service): Promise<void> {
		const name = service.metadata?.name;
		const namespace = service.metadata?.namespace ?? "default";
		if (name) {
			try {
				service = await ctx.api.corev1.readNamespacedService({ name, namespace });
				this.services.set(serviceKey(service), service);
			} catch (error) {
				if (!isNotFoundError(error)) {
					throw error;
				}
				await this.deleteGeneratedSlice(ctx, service);
				return;
			}
		}
		const selector = new Map(Object.entries(service.spec?.selector ?? {}));
		if (service.metadata?.deletionTimestamp) {
			return;
		}
		if (!name || selector.size === 0 || service.spec?.type === "ExternalName") {
			await this.deleteGeneratedSlice(ctx, service);
			return;
		}

		const matchingPods = [...(this.podsByNamespace.get(namespace) ?? [])]
			.map((key) => this.pods.get(key))
			.filter((pod): pod is k8s.V1Pod => pod !== undefined)
			.filter((pod) => labelsMatch(selector, new Map(Object.entries(pod.metadata?.labels ?? {}))))
			.filter((pod) => shouldPodBeInEndpointSlice(pod));
		const slice = this.endpointSliceForService(service, matchingPods);
		await this.applyEndpointSlice(ctx, slice);
	}

	private endpointSliceForService(service: k8s.V1Service, pods: k8s.V1Pod[]): k8s.V1EndpointSlice {
		const namespace = service.metadata?.namespace ?? "default";
		const name = service.metadata?.name ?? "";
		const addressType = endpointSliceAddressType(service, pods);
		return {
			apiVersion: "discovery.k8s.io/v1",
			kind: "EndpointSlice",
			addressType,
			metadata: {
				name: generatedSliceName(name),
				namespace,
				labels: endpointSliceLabels(service),
				ownerReferences: serviceOwnerReferences(service),
			},
			ports:
				pods.length === 0
					? []
					: (service.spec?.ports ?? []).flatMap((port) => {
							const endpointPort = resolveEndpointPort(port, pods);
							return endpointPort === undefined
								? []
								: [
										{
											appProtocol: port.appProtocol,
											name: port.name,
											port: endpointPort,
											protocol: port.protocol ?? "TCP",
										},
									];
						}),
			endpoints: pods.flatMap((pod) => {
				const addresses = endpointAddresses(pod, addressType);
				if (addresses.length === 0) {
					return [];
				}
				const serving = isReadyPod(pod);
				const terminating = pod.metadata?.deletionTimestamp !== undefined;
				const ready = service.spec?.publishNotReadyAddresses === true || (serving && !terminating);
				return [
					{
						addresses,
						conditions: {
							ready,
							serving,
							terminating,
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

	private async applyEndpointSlice(ctx: ProcessContext, slice: k8s.V1EndpointSlice): Promise<void> {
		const name = slice.metadata?.name ?? "";
		const namespace = slice.metadata?.namespace ?? "default";
		const serviceName = slice.metadata?.labels?.[labelServiceName];
		if (serviceName) {
			try {
				const service = await ctx.api.corev1.readNamespacedService({
					name: serviceName,
					namespace,
				});
				if (service.metadata?.deletionTimestamp) {
					return;
				}
			} catch (error) {
				if (!isNotFoundError(error)) {
					throw error;
				}
				return;
			}
		}
		const cached = this.endpointSlices.get(`${namespace}/${name}`);
		if (cached?.metadata?.deletionTimestamp) {
			return;
		}
		try {
			await retryConflicts(ctx, async () => {
				try {
					const current = await ctx.api.discoveryv1.readNamespacedEndpointSlice({
						name,
						namespace,
					});
					if (current.metadata?.deletionTimestamp) {
						return;
					}
					const desiredOwnerReferences = slice.metadata?.ownerReferences ?? [];
					if (
						desiredOwnerReferences.length > 0 &&
						!desiredOwnerReferences.some((desiredOwner) =>
							(current.metadata?.ownerReferences ?? []).some((currentOwner) =>
								ownerReferencesEqual(currentOwner, desiredOwner),
							),
						)
					) {
						return;
					}
					const desired = {
						...slice,
						metadata: {
							...slice.metadata,
							finalizers: current.metadata?.finalizers,
							ownerReferences: current.metadata?.ownerReferences,
							resourceVersion: current.metadata?.resourceVersion,
						},
					};
					if (
						deepEqual(current, desired, {
							ignoredFields: ["metadata.resourceVersion"],
							ignoreUndefined: true,
						})
					) {
						return;
					}
					await ctx.api.discoveryv1.replaceNamespacedEndpointSlice({
						name,
						namespace,
						body: desired,
					});
				} catch (error) {
					if (!isNotFoundError(error)) {
						throw error;
					}
					await ctx.api.discoveryv1.createNamespacedEndpointSlice({ namespace, body: slice });
				}
			});
		} catch (error) {
			if (!isNotFoundError(error)) {
				throw error;
			}
		}
	}

	private async deleteGeneratedSlice(ctx: ProcessContext, service: k8s.V1Service): Promise<void> {
		const name = service.metadata?.name;
		if (!name) {
			return;
		}
		const namespace = service.metadata?.namespace ?? "default";
		const sliceName = generatedSliceName(name);
		try {
			const slice = await ctx.api.discoveryv1.readNamespacedEndpointSlice({
				name: sliceName,
				namespace,
			});
			if (!isOwnedByService(slice, service)) {
				return;
			}
			await ctx.api.discoveryv1.deleteNamespacedEndpointSlice({
				name: sliceName,
				namespace,
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

function endpointSliceKey(slice: k8s.V1EndpointSlice): string {
	return `${slice.metadata?.namespace ?? "default"}/${slice.metadata?.name ?? ""}`;
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

function endpointSliceLabels(service: k8s.V1Service): { [key: string]: string } {
	const labels: { [key: string]: string } = {};
	for (const [key, value] of Object.entries(service.metadata?.labels ?? {})) {
		if (!isReservedEndpointSliceLabel(key)) {
			labels[key] = value;
		}
	}
	if (service.spec?.clusterIP === "None") {
		labels[labelHeadlessService] = "";
	}
	labels[labelServiceName] = service.metadata?.name ?? "";
	labels[labelManagedBy] = controllerName;
	return labels;
}

function isReservedEndpointSliceLabel(label: string): boolean {
	return label === labelServiceName || label === labelManagedBy || label === labelHeadlessService;
}

function serviceOwnerReferences(service: k8s.V1Service): k8s.V1OwnerReference[] {
	const name = service.metadata?.name;
	const uid = service.metadata?.uid;
	if (!name || !uid) {
		return [];
	}
	return [
		{
			apiVersion: "v1",
			blockOwnerDeletion: true,
			controller: true,
			kind: "Service",
			name,
			uid,
		},
	];
}

function isOwnedByService(slice: k8s.V1EndpointSlice, service: k8s.V1Service): boolean {
	const serviceUid = service.metadata?.uid;
	if (!serviceUid) {
		return false;
	}
	return (slice.metadata?.ownerReferences ?? []).some(
		(reference) =>
			reference.apiVersion === "v1" &&
			reference.kind === "Service" &&
			reference.name === service.metadata?.name &&
			reference.uid === serviceUid,
	);
}

function ownerReferencesEqual(left: k8s.V1OwnerReference, right: k8s.V1OwnerReference): boolean {
	return (
		left.apiVersion === right.apiVersion &&
		left.kind === right.kind &&
		left.name === right.name &&
		left.uid === right.uid
	);
}

function shouldPodBeInEndpointSlice(pod: k8s.V1Pod): boolean {
	return podIPs(pod).length > 0;
}

function isReadyPod(pod: k8s.V1Pod): boolean {
	if (!pod.status || pod.status.phase !== "Running") {
		return false;
	}
	if ((pod.status.conditions ?? []).some((condition) => condition.type === "Ready")) {
		return isPodReadyConditionTrue(pod.status);
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

function endpointSliceAddressType(service: k8s.V1Service, pods: readonly k8s.V1Pod[]): string {
	const supportedAddressTypes = serviceSupportedAddressTypes(service);
	for (const addressType of supportedAddressTypes) {
		if (pods.some((pod) => endpointAddresses(pod, addressType).length > 0)) {
			return addressType;
		}
	}
	return supportedAddressTypes[0] ?? "IPv4";
}

function serviceSupportedAddressTypes(service: k8s.V1Service): string[] {
	const ipFamilies = service.spec?.ipFamilies ?? [];
	const addressTypes = ipFamilies.flatMap((family) => {
		if (family === "IPv4") {
			return ["IPv4"];
		}
		if (family === "IPv6") {
			return ["IPv6"];
		}
		return [];
	});
	if (addressTypes.length > 0) {
		return addressTypes;
	}

	const clusterIP = service.spec?.clusterIP;
	if (clusterIP && clusterIP !== "None") {
		return [isIPv6String(clusterIP) ? "IPv6" : "IPv4"];
	}
	return ["IPv4", "IPv6"];
}

function endpointAddresses(pod: k8s.V1Pod, addressType: string): string[] {
	return podIPs(pod).filter((ip) => addressTypeForIP(ip) === addressType);
}

function podIPs(pod: k8s.V1Pod): string[] {
	const podIPs = (pod.status?.podIPs ?? [])
		.map((podIP) => podIP.ip)
		.filter((ip): ip is string => ip !== undefined && ip !== "");
	if (podIPs.length > 0) {
		return podIPs;
	}
	return pod.status?.podIP ? [pod.status.podIP] : [];
}

function addressTypeForIP(ip: string): string {
	return isIPv6String(ip) ? "IPv6" : "IPv4";
}

function isIPv6String(ip: string): boolean {
	return ip.includes(":");
}

function resolveEndpointPort(
	servicePort: k8s.V1ServicePort,
	pods: readonly k8s.V1Pod[],
): number | undefined {
	const targetPort = servicePort.targetPort ?? servicePort.port;
	if (typeof targetPort === "number") {
		return targetPort;
	}
	const protocol = servicePort.protocol ?? "TCP";
	for (const pod of pods) {
		for (const container of pod.spec?.containers ?? []) {
			const match = container.ports?.find(
				(containerPort) =>
					containerPort.name === targetPort && (containerPort.protocol ?? "TCP") === protocol,
			);
			if (match) {
				return match.containerPort;
			}
		}
	}
	return undefined;
}
