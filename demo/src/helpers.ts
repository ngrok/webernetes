import * as w8s from "webernetes";

export const demoRequestIdHeader = "X-Demo-Request-Id";
export const demoRequestOriginHeader = "X-Demo-Request-Origin";
export const demoRequestTypeHeader = "X-Demo-Request-Type";
export const demoRequestTypeButtonClick = "button-click";
export const demoRequestTypeScheduledJob = "scheduled-job";
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
