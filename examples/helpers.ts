import type { Cluster, V1Deployment, V1Pod } from "../src";

export function waitForPodReady(cluster: Cluster, pod: V1Pod): Promise<V1Pod>;
export function waitForPodReady(cluster: Cluster, ...pods: V1Pod[]): Promise<V1Pod[]>;
export async function waitForPodReady(
	cluster: Cluster,
	...pods: V1Pod[]
): Promise<V1Pod | V1Pod[]> {
	const readyPods = await Promise.all(pods.map((pod) => waitForOnePodReady(cluster, pod)));
	return pods.length === 1 ? readyPods[0] : readyPods;
}

async function waitForOnePodReady(cluster: Cluster, pod: V1Pod): Promise<V1Pod> {
	const namespace = pod.metadata?.namespace ?? "default";
	const name = requireName(pod);
	const [readyPod] = await waitForReadyPods(cluster, namespace, 1, {
		fieldSelector: `metadata.name=${name}`,
	});
	if (!readyPod) {
		throw new Error(`Pod ${namespace}/${name} was not found`);
	}
	return readyPod;
}

export async function waitForDeploymentReady(
	cluster: Cluster,
	deployment: V1Deployment,
): Promise<void> {
	const namespace = deployment.metadata?.namespace ?? "default";
	const replicas = deployment.spec?.replicas ?? 1;
	await waitForReadyPods(cluster, namespace, replicas, {
		labelSelector: labelSelectorForDeployment(deployment),
	});
}

async function waitForReadyPods(
	cluster: Cluster,
	namespace: string,
	count: number,
	selectors: { fieldSelector?: string; labelSelector?: string },
): Promise<V1Pod[]> {
	const readyPods = new Set<string>();
	const podsByName = new Map<string, V1Pod>();
	let resolveReady!: (pods: V1Pod[]) => void;
	let rejectReady!: (error: unknown) => void;

	const ready = new Promise<V1Pod[]>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});

	const informer = cluster.informer(
		"pods",
		(type, pod) => {
			const name = pod.metadata?.name;
			if (!name) {
				return;
			}
			if (type === "delete" || !isPodReady(pod)) {
				readyPods.delete(name);
				podsByName.delete(name);
			} else {
				readyPods.add(name);
				podsByName.set(name, pod);
			}
			if (readyPods.size >= count) {
				// Let service routing controllers consume the same Ready update.
				void cluster.clock.wait(50).then(() => resolveReady([...podsByName.values()]), rejectReady);
			}
		},
		{
			namespace,
			fieldSelector: selectors.fieldSelector,
			labelSelector: selectors.labelSelector,
			onError: rejectReady,
		},
	);

	try {
		return await Promise.race([
			ready,
			cluster.clock.wait(10_000).then(() => {
				throw new Error(`Timed out waiting for ${count} ready pod(s) in ${namespace}`);
			}),
		]);
	} finally {
		await informer.stop();
	}
}

function isPodReady(pod: V1Pod): boolean {
	return (
		pod.status?.conditions?.some((condition) => {
			return condition.type === "Ready" && condition.status === "True";
		}) === true
	);
}

function labelSelectorForDeployment(deployment: V1Deployment): string {
	const matchLabels = deployment.spec?.selector?.matchLabels;
	if (!matchLabels || Object.keys(matchLabels).length === 0) {
		throw new Error(`Deployment ${requireName(deployment)} does not have matchLabels`);
	}
	return Object.entries(matchLabels)
		.map(([key, value]) => `${key}=${value}`)
		.join(",");
}

function requireName(resource: V1Pod | V1Deployment): string {
	const name = resource.metadata?.name;
	if (!name) {
		throw new Error("Resource does not have metadata.name");
	}
	return name;
}
