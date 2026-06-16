import * as w8s from "webernetes";

export const demoRequestIdHeader = "X-Demo-Request-Id";
export const demoRequestOriginHeader = "X-Demo-Request-Origin";
export const demoRequestTypeHeader = "X-Demo-Request-Type";
export const demoRequestTypeButtonClick = "button-click";
export const demoRequestTypeTrafficGenerator = "traffic-generator";
export const demoHealthPort = 8081;
export const demoControlPort = 9000;
export const healthCheckHeader = "X-Webernetes-Health-Check";
export const sendRequestButtonId = "send-request-button";

export interface Point {
	x: number;
	y: number;
}

export function center(element: HTMLElement, relativeTo?: HTMLElement): Point {
	const rect = element.getBoundingClientRect();
	const relativeRect = relativeTo?.getBoundingClientRect();
	return {
		x: rect.left - (relativeRect?.left ?? 0) + rect.width / 2,
		y: rect.top - (relativeRect?.top ?? 0) + rect.height / 2,
	};
}

export function distance(from: HTMLElement, to: HTMLElement): number {
	const fromCenter = center(from);
	const toCenter = center(to);
	return Math.hypot(toCenter.x - fromCenter.x, toCenter.y - fromCenter.y);
}

export function idFor(resource: w8s.KubernetesObject): string {
	const [group, version] = apiGroupVersion(resource);
	const parts = [
		version,
		group,
		resource.kind ?? "",
		getNamespace(resource) ?? "",
		getName(resource),
	];
	return `k8s-${parts.map(idPart).join("-")}`;
}

export function kubeletIdForNodeName(name: string): string {
	return `kubelet-${idPart(name)}`;
}

export function getName(resource: w8s.KubernetesObject, fallback = ""): string {
	return resource.metadata?.name ?? fallback;
}

export function getNamespace(resource: w8s.KubernetesObject): string {
	return resource.metadata?.namespace ?? "default";
}

export function getReadyContainers(pod: w8s.V1Pod): number {
	return pod.status?.containerStatuses?.filter((status) => status.ready).length ?? 0;
}

export function hasReadiness(pod: w8s.V1Pod): boolean {
	return pod.spec?.containers?.some((container) => container.readinessProbe !== undefined) ?? false;
}

export function getRestartCount(pod: w8s.V1Pod): number {
	return (
		pod.status?.containerStatuses?.reduce((count, status) => count + status.restartCount, 0) ?? 0
	);
}

export function podIdsForService(service: w8s.V1Service, pods: w8s.V1Pod[]): Set<string> {
	const selector = service.spec?.selector;
	if (!selector || Object.keys(selector).length === 0) {
		return new Set();
	}
	const namespace = getNamespace(service);
	return new Set(
		pods
			.filter((pod) => getNamespace(pod) === namespace && labelsMatchSelector(pod, selector))
			.map(idFor),
	);
}

export function podIdsForLabelSelector(
	selector: w8s.V1LabelSelector | undefined,
	namespace: string,
	pods: w8s.V1Pod[],
): Set<string> {
	if (
		!selector ||
		(Object.keys(selector.matchLabels ?? {}).length === 0 &&
			(selector.matchExpressions?.length ?? 0) === 0)
	) {
		return new Set();
	}
	return new Set(
		pods
			.filter((pod) => getNamespace(pod) === namespace && labelsMatchLabelSelector(pod, selector))
			.map(idFor),
	);
}

function labelsMatchSelector(pod: w8s.V1Pod, selector: Record<string, string>): boolean {
	const labels = pod.metadata?.labels ?? {};
	return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

function labelsMatchLabelSelector(pod: w8s.V1Pod, selector: w8s.V1LabelSelector): boolean {
	const labels = pod.metadata?.labels ?? {};
	return (
		Object.entries(selector.matchLabels ?? {}).every(([key, value]) => labels[key] === value) &&
		(selector.matchExpressions ?? []).every((expression) =>
			labelExpressionMatches(labels, expression),
		)
	);
}

function labelExpressionMatches(
	labels: Record<string, string>,
	expression: w8s.V1LabelSelectorRequirement,
): boolean {
	const hasLabel = Object.hasOwn(labels, expression.key);
	const values = expression.values ?? [];
	switch (expression.operator) {
		case "In":
			return hasLabel && values.includes(labels[expression.key] ?? "");
		case "NotIn":
			return !hasLabel || !values.includes(labels[expression.key] ?? "");
		case "Exists":
			return hasLabel;
		case "DoesNotExist":
			return !hasLabel;
		default:
			return false;
	}
}

export async function getNodePort(
	cluster: w8s.Cluster,
	namespace: string,
	serviceName: string,
): Promise<number> {
	const service = await cluster.api.corev1.readNamespacedService({
		namespace,
		name: serviceName,
	});
	const nodePort = service.spec?.ports?.[0]?.nodePort;
	if (nodePort === undefined) {
		throw new Error(`Service ${namespace}/${serviceName} does not have a node port`);
	}
	return nodePort;
}

export async function fetchPodPort(
	cluster: w8s.Cluster,
	pod: w8s.V1Pod,
	port: number,
	path: string,
	init?: Parameters<w8s.Cluster["fetch"]>[1],
): Promise<w8s.HttpResponse> {
	const podIP = pod.status?.podIP ?? pod.status?.podIPs?.[0]?.ip;
	if (!podIP) {
		throw new Error(`Pod ${getNamespace(pod)}/${getName(pod)} does not have a pod IP`);
	}
	const host = podIP.includes(":") ? `[${podIP}]` : podIP;
	return await cluster.fetch(`http://${host}:${port}${path}`, init);
}

export function getHeader(headers: w8s.HttpHeader, name: string): string | undefined {
	const lowerName = name.toLowerCase();
	const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === lowerName);
	return key ? headers[key]?.[0] : undefined;
}

export function sortByName<T extends w8s.KubernetesObject>(items: T[]): T[] {
	return [...items].toSorted((a, b) => resourceSortName(a).localeCompare(resourceSortName(b)));
}

function apiGroupVersion(resource: w8s.KubernetesObject): [group: string, version: string] {
	const apiVersion = resource.apiVersion ?? "";
	if (!apiVersion.includes("/")) {
		return ["core", apiVersion];
	}
	const [group, version] = apiVersion.split("/", 2);
	return [group, version];
}

function idPart(value: string): string {
	const encoded = encodeURIComponent(value);
	return `${encoded.length}-${encoded}`;
}

function resourceSortName(resource: w8s.KubernetesObject): string {
	const name = getName(resource);
	const namespace = getNamespace(resource);
	return namespace ? `${namespace}/${name}` : name;
}
