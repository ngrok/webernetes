import * as w8s from "webernetes";

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

export function getRestartCount(pod: w8s.V1Pod): number {
	return (
		pod.status?.containerStatuses?.reduce((count, status) => count + status.restartCount, 0) ?? 0
	);
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
