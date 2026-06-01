import type { V1Container, V1Pod, V1ResourceRequirements } from "../../../../../../client";

type ResourceList = NonNullable<V1ResourceRequirements["requests"]>;

// Models kubernetes/pkg/apis/core/v1/helper/qos/qos.go supportedQoSComputeResources.
const supportedQoSComputeResources = new Set(["cpu", "memory"]);

// Models kubernetes/pkg/apis/core/v1/helper/qos/qos.go QOSList.
export type QOSList = Map<string, string>;

// Models kubernetes/pkg/apis/core/v1/helper/qos/qos.go isSupportedQoSComputeResource.
function isSupportedQoSComputeResource(name: string): boolean {
	return supportedQoSComputeResources.has(name);
}

// Models kubernetes/pkg/apis/core/v1/helper/qos/qos.go GetPodQOS.
export function getPodQOS(pod: V1Pod): string {
	if (pod.status?.qosClass) {
		return pod.status.qosClass;
	}
	return computePodQOS(pod);
}

// Models kubernetes/pkg/apis/core/v1/helper/qos/qos.go processResourceList.
function processResourceList(list: Map<string, number>, newList: ResourceList): void {
	for (const [name, quantity] of Object.entries(newList)) {
		if (!isSupportedQoSComputeResource(name)) {
			continue;
		}
		const value = quantityValue(name, quantity);
		if (quantitySign(value) === 1) {
			list.set(name, value + (list.get(name) ?? 0));
		}
	}
}

// Models kubernetes/pkg/apis/core/v1/helper/qos/qos.go getQOSResources.
function getQOSResources(list: ResourceList): Set<string> {
	const qosResources = new Set<string>();
	for (const [name, quantity] of Object.entries(list)) {
		if (!isSupportedQoSComputeResource(name)) {
			continue;
		}
		if (quantitySign(quantityValue(name, quantity)) === 1) {
			qosResources.add(name);
		}
	}
	return qosResources;
}

// Models kubernetes/pkg/apis/core/v1/helper/qos/qos.go ComputePodQOS.
export function computePodQOS(pod: V1Pod): string {
	const requests = new Map<string, number>();
	const limits = new Map<string, number>();
	let isGuaranteed = true;

	if (pod.spec?.resources !== undefined) {
		pod.spec.resources.requests ??= {};
		pod.spec.resources.limits ??= {};

		if (Object.keys(pod.spec.resources.requests).length > 0) {
			processResourceList(requests, pod.spec.resources.requests);
		}

		if (Object.keys(pod.spec.resources.limits).length > 0) {
			processResourceList(limits, pod.spec.resources.limits);
			const qosLimitResources = getQOSResources(pod.spec.resources.limits);
			if (!hasAll(qosLimitResources, "memory", "cpu")) {
				isGuaranteed = false;
			}
		}
	} else {
		const allContainers: V1Container[] = [];
		allContainers.push(...(pod.spec?.containers ?? []));
		allContainers.push(...(pod.spec?.initContainers ?? []));
		for (const container of allContainers) {
			for (const [name, quantity] of Object.entries(container.resources?.requests ?? {})) {
				if (!isSupportedQoSComputeResource(name)) {
					continue;
				}
				const value = quantityValue(name, quantity);
				if (quantitySign(value) === 1) {
					requests.set(name, value + (requests.get(name) ?? 0));
				}
			}

			const qosLimitsFound = new Set<string>();
			for (const [name, quantity] of Object.entries(container.resources?.limits ?? {})) {
				if (!isSupportedQoSComputeResource(name)) {
					continue;
				}
				const value = quantityValue(name, quantity);
				if (quantitySign(value) === 1) {
					qosLimitsFound.add(name);
					limits.set(name, value + (limits.get(name) ?? 0));
				}
			}

			if (!hasAll(qosLimitsFound, "memory", "cpu")) {
				isGuaranteed = false;
			}
		}
	}

	if (requests.size === 0 && limits.size === 0) {
		return "BestEffort";
	}
	if (isGuaranteed) {
		for (const [name, request] of requests) {
			if (!limits.has(name) || limits.get(name) !== request) {
				isGuaranteed = false;
				break;
			}
		}
	}
	if (isGuaranteed && requests.size === limits.size) {
		return "Guaranteed";
	}
	return "Burstable";
}

function hasAll(values: Set<string>, ...required: string[]): boolean {
	return required.every((value) => values.has(value));
}

// Upstream uses k8s.io/apimachinery/pkg/api/resource.Quantity for Sign, Add,
// DeepCopy, and Cmp. The simulator stores generated quantities as strings, so
// this is a scoped parser for QoS CPU/memory comparisons until Quantity is
// mirrored locally.
function quantitySign(quantity: number): -1 | 0 | 1 {
	if (quantity === 0) {
		return 0;
	}
	return quantity > 0 ? 1 : -1;
}

function quantityValue(resourceName: string, quantity: string): number {
	const trimmed = quantity.trim();
	if (trimmed === "") {
		return 0;
	}
	if (resourceName === "cpu") {
		return cpuQuantityValue(trimmed);
	}
	return memoryQuantityValue(trimmed);
}

function cpuQuantityValue(quantity: string): number {
	if (quantity.endsWith("m")) {
		return Number(quantity.slice(0, -1));
	}
	return Number(quantity) * 1000;
}

function memoryQuantityValue(quantity: string): number {
	const match = quantity.match(/^(-?\d+(?:\.\d+)?)([KMGTPE]i?|m?)?$/u);
	if (!match) {
		return Number(quantity);
	}
	const value = Number(match[1]);
	const suffix = match[2] ?? "";
	const multipliers: Record<string, number> = {
		"": 1,
		m: 0.001,
		K: 1000,
		Ki: 1024,
		M: 1000 ** 2,
		Mi: 1024 ** 2,
		G: 1000 ** 3,
		Gi: 1024 ** 3,
		T: 1000 ** 4,
		Ti: 1024 ** 4,
		P: 1000 ** 5,
		Pi: 1024 ** 5,
		E: 1000 ** 6,
		Ei: 1024 ** 6,
	};
	return value * (multipliers[suffix] ?? 1);
}
