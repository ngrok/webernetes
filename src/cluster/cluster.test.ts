import { expect, it } from "vitest";

import { select } from "../go/channel";
import { browser } from "../test/describe";
import { waitFor } from "../test/wait";
import { Cluster, type ClusterInformerEventType, type ClusterInformerResource } from "./cluster";
import type { NetworkRequestEvent, NetworkResponseEvent } from "./cni/network";
import { BaseImage } from "./images/base";
import type { Kubelet } from "./kubelet";
import { ProbeManagerImpl } from "./kubelet/prober";
import { getLatencyProvider, newLatencyProvider } from "../latency";

type InformerObject = { metadata?: { name?: string } };

class TestImage extends BaseImage {
	static readonly imageName = "example/test";
	static readonly imageVersion = "1.0";
}

async function probeResultChannelsAreOpen(kubelet: Kubelet): Promise<boolean> {
	const probeManager = kubelet.probeManager;
	if (!(probeManager instanceof ProbeManagerImpl)) {
		throw new Error("expected kubelet probe manager implementation");
	}
	for (const updates of [
		probeManager.livenessManager.updates(),
		probeManager.readinessManager.updates(),
		probeManager.startupManager.updates(),
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

function startClusterInformer(
	cluster: Cluster,
	resource: ClusterInformerResource,
	fieldSelector: string,
	events: Array<{ type: string; name: string | undefined }>,
): { stop(): Promise<void> } {
	const callback = (type: ClusterInformerEventType, object: InformerObject) => {
		events.push({ type, name: object.metadata?.name });
	};
	const options = { fieldSelector };
	return cluster.informer(resource, callback, options);
}

async function createInformerFieldSelectorFixture(
	cluster: Cluster,
	resource: ClusterInformerResource,
	namespace: string,
	name: string,
	fieldValue: string,
): Promise<void> {
	const metadata = {
		name,
		labels: { clusterInformerField: fieldValue },
	};
	switch (resource) {
		case "pods":
			await cluster.api.corev1.createNamespacedPod({
				namespace,
				body: {
					metadata,
					spec: {
						nodeName: "node-1",
						containers: [{ name: "pause", image: "registry.k8s.io/pause:3.10" }],
					},
				},
			});
			return;
		case "services":
			await cluster.api.corev1.createNamespacedService({
				namespace,
				body: {
					metadata,
					spec: { ports: [{ port: 80 }] },
				},
			});
			return;
		case "namespaces":
			await cluster.api.corev1.createNamespace({
				body: { metadata },
			});
			return;
		case "nodes":
			await cluster.api.corev1.createNode({
				body: {
					metadata,
					status: {
						addresses: [{ type: "Hostname", address: name }],
					},
				},
			});
			return;
		case "events":
			await cluster.api.corev1.createNamespacedEvent({
				namespace,
				body: {
					metadata,
					involvedObject: { kind: "Pod", namespace, name: "field-selector-subject" },
				},
			});
			return;
		case "endpointslices":
			await cluster.api.discoveryv1.createNamespacedEndpointSlice({
				namespace,
				body: {
					addressType: "IPv4",
					endpoints: [],
					metadata,
				},
			});
			return;
	}
}

browser.describe("Cluster nodes", () => {
	it("defaults to a no-op latency provider on the cluster context", async () => {
		const cluster = new Cluster();
		try {
			const l = getLatencyProvider(cluster.ctx);
			expect(l.clusterNetworkRequestLatency([])).toBe(0);
			expect(l.clusterNetworkResponseLatency([])).toBe(0);
		} finally {
			await cluster.close();
		}
	});

	it("stores the configured latency provider on the cluster context", async () => {
		const latencyProvider = newLatencyProvider({
			clusterNetworkRequestLatency: () => 12,
			clusterNetworkResponseLatency: () => 34,
		});
		const cluster = new Cluster({ latencyProvider });
		try {
			expect(getLatencyProvider(cluster.ctx)).toBe(latencyProvider);
		} finally {
			await cluster.close();
		}
	});

	it("publishes server IP addresses on node status", async () => {
		const cluster = new Cluster();
		await cluster.init();
		try {
			const nodes = await cluster.api.corev1.listNode();
			for (const server of cluster.servers) {
				const node = nodes.items.find((candidate) => candidate.metadata?.name === server.name);
				expect(node?.status?.addresses).toEqual([
					...server.ipAddresses.map((address) => ({ type: "InternalIP", address })),
					{ type: "Hostname", address: server.name },
				]);
				const [kubeletNode, kubeletNodeErr] = await server.kubelet.getNode(cluster.ctx);
				expect(kubeletNodeErr).toBeUndefined();
				expect(kubeletNode).toEqual(node);
				expect(server.kubelet.nodeHasSynced()).toBe(true);
			}
		} finally {
			await cluster.close();
		}
	});

	it("creates informers for all resource kinds with field selectors", async () => {
		const cluster = new Cluster();
		await cluster.init();
		try {
			const namespace = "cluster-informer-field-selector";
			await cluster.api.corev1.createNamespace({
				body: { metadata: { name: namespace } },
			});

			for (const resource of [
				"pods",
				"services",
				"namespaces",
				"nodes",
				"events",
				"endpointslices",
			] satisfies ClusterInformerResource[]) {
				const matchingName = `matching-${resource}`;
				const nonMatchingName = `other-${resource}`;
				const futureMatchingName = `future-${resource}`;
				const futureNonMatchingName = `future-other-${resource}`;
				await createInformerFieldSelectorFixture(
					cluster,
					resource,
					namespace,
					matchingName,
					"match",
				);
				await createInformerFieldSelectorFixture(
					cluster,
					resource,
					namespace,
					nonMatchingName,
					"other",
				);

				const events: Array<{ type: string; name: string | undefined }> = [];
				const informer = startClusterInformer(
					cluster,
					resource,
					"metadata.labels.clusterInformerField=match",
					events,
				);
				try {
					await waitFor(() => {
						expect(events).toContainEqual({ type: "add", name: matchingName });
					});
					expect(events).not.toContainEqual({ type: "add", name: nonMatchingName });

					await createInformerFieldSelectorFixture(
						cluster,
						resource,
						namespace,
						futureMatchingName,
						"match",
					);
					await createInformerFieldSelectorFixture(
						cluster,
						resource,
						namespace,
						futureNonMatchingName,
						"other",
					);
					await waitFor(() => {
						expect(events).toContainEqual({ type: "add", name: futureMatchingName });
					});
					expect(events).not.toContainEqual({ type: "add", name: futureNonMatchingName });
				} finally {
					await informer.stop();
				}
			}
		} finally {
			await cluster.close();
		}
	});
});

browser.describe("Cluster images", () => {
	it("registers image constructors", async () => {
		const cluster = new Cluster();
		try {
			cluster.registerImage(TestImage);

			const first = cluster.imageRegistry.create("example/test:latest");
			const second = cluster.imageRegistry.create("example/test:latest");

			expect(first).toBeInstanceOf(TestImage);
			expect(second).toBeInstanceOf(TestImage);
			expect(first).not.toBe(second);
		} finally {
			await cluster.close();
		}
	});
});

browser.describe("Cluster network events", () => {
	it("delegates request and response listeners to the cluster network", async () => {
		const cluster = new Cluster();
		try {
			const requestEvents: NetworkRequestEvent[] = [];
			const responseEvents: NetworkResponseEvent[] = [];
			const addedRequestEvents: NetworkRequestEvent[] = [];
			const addedResponseEvents: NetworkResponseEvent[] = [];
			const onceRequestEvents: NetworkRequestEvent[] = [];
			const onceResponseEvents: NetworkResponseEvent[] = [];
			const requestEvent: NetworkRequestEvent = {
				request: {
					method: "GET",
					url: new URL("http://example.com/"),
					header: {},
					host: "example.com",
				},
				chain: [],
				latencyMs: 0,
			};
			const responseEvent: NetworkResponseEvent = {
				request: requestEvent.request,
				response: { status: 200, body: "ok" },
				chain: [],
				latencyMs: 0,
			};

			const onRequest = (event: NetworkRequestEvent) => requestEvents.push(event);
			const onResponse = (event: NetworkResponseEvent) => responseEvents.push(event);
			const addRequest = (event: NetworkRequestEvent) => addedRequestEvents.push(event);
			const addResponse = (event: NetworkResponseEvent) => addedResponseEvents.push(event);
			const onceRequest = (event: NetworkRequestEvent) => onceRequestEvents.push(event);
			const onceResponse = (event: NetworkResponseEvent) => onceResponseEvents.push(event);

			expect(cluster.on("request", onRequest)).toBe(cluster);
			expect(cluster.on("response", onResponse)).toBe(cluster);
			expect(cluster.addListener("request", addRequest)).toBe(cluster);
			expect(cluster.addListener("response", addResponse)).toBe(cluster);
			expect(cluster.once("request", onceRequest)).toBe(cluster);
			expect(cluster.once("response", onceResponse)).toBe(cluster);

			cluster.network.emit("request", requestEvent);
			cluster.network.emit("response", responseEvent);

			expect(requestEvents).toEqual([requestEvent]);
			expect(responseEvents).toEqual([responseEvent]);
			expect(addedRequestEvents).toEqual([requestEvent]);
			expect(addedResponseEvents).toEqual([responseEvent]);
			expect(onceRequestEvents).toEqual([requestEvent]);
			expect(onceResponseEvents).toEqual([responseEvent]);

			expect(cluster.off("request", onRequest)).toBe(cluster);
			expect(cluster.off("response", onResponse)).toBe(cluster);
			expect(cluster.removeListener("request", addRequest)).toBe(cluster);
			expect(cluster.removeListener("response", addResponse)).toBe(cluster);

			cluster.network.emit("request", requestEvent);
			cluster.network.emit("response", responseEvent);

			expect(requestEvents).toEqual([requestEvent]);
			expect(responseEvents).toEqual([responseEvent]);
			expect(addedRequestEvents).toEqual([requestEvent]);
			expect(addedResponseEvents).toEqual([responseEvent]);
			expect(onceRequestEvents).toEqual([requestEvent]);
			expect(onceResponseEvents).toEqual([responseEvent]);
		} finally {
			await cluster.close();
		}
	});
});

browser.describe("Cluster shutdown", () => {
	it("canceling cluster context exits kubelet loops without closing probe result channels", async () => {
		const cluster = new Cluster();
		await cluster.init();
		try {
			await cluster.close();

			for (const server of cluster.servers) {
				expect(server.kubelet.isSyncLoopExited()).toBe(true);
				await expect(probeResultChannelsAreOpen(server.kubelet)).resolves.toBe(true);
			}
		} finally {
			await cluster.close();
		}
	});

	it("stops kubelets, prober workers, runtime processes, and timers", async () => {
		const cluster = new Cluster();
		await cluster.init();
		try {
			await cluster.api.corev1.createNamespacedPod({
				namespace: "default",
				body: {
					metadata: { name: "shutdown-probed" },
					spec: {
						nodeName: "node-1",
						containers: [
							{
								name: "agnhost",
								image: "registry.k8s.io/e2e-test-images/agnhost:2.40",
								ports: [{ name: "http", containerPort: 8080 }],
								readinessProbe: {
									httpGet: { path: "/readyz", port: "http" },
									initialDelaySeconds: 30,
									periodSeconds: 30,
								},
								livenessProbe: {
									httpGet: { path: "/healthz", port: "http" },
									initialDelaySeconds: 30,
									periodSeconds: 30,
								},
							},
						],
					},
				},
			});

			await waitFor(() => {
				expect(cluster.servers[0].kubelet.probeWorkerCount()).toBeGreaterThan(0);
			});

			await cluster.close();
			await expect(cluster.close()).resolves.toBeUndefined();

			for (const server of cluster.servers) {
				expect(server.kubelet.isSyncLoopExited()).toBe(true);
				expect(server.kubelet.probeWorkerCount()).toBe(0);
				await expect(probeResultChannelsAreOpen(server.kubelet)).resolves.toBe(true);
				expect(server.runtime.sandboxCount()).toBe(0);
				expect(server.runtime.containerCount()).toBe(0);
				expect(server.runtime.processCount()).toBe(0);
				expect(server.runtime.processListenerCount()).toBe(0);
			}
			expect(cluster.clock.pendingTaskCount()).toBe(0);
		} finally {
			await cluster.close();
		}
	});

	it("cancels in-flight exec probes during shutdown", async () => {
		const cluster = new Cluster();
		await cluster.init();
		try {
			await cluster.api.corev1.createNamespacedPod({
				namespace: "default",
				body: {
					metadata: { name: "shutdown-exec-probed" },
					spec: {
						nodeName: "node-1",
						containers: [
							{
								name: "busybox",
								image: "busybox:1.36",
								readinessProbe: {
									exec: { command: ["sleep", "3600"] },
									periodSeconds: 1,
									timeoutSeconds: 30,
								},
							},
						],
					},
				},
			});

			await waitFor(() => {
				expect(cluster.servers[0].runtime.processCount()).toBeGreaterThan(1);
			});

			await cluster.close();

			for (const server of cluster.servers) {
				expect(server.runtime.processCount()).toBe(0);
				expect(server.kubelet.probeWorkerCount()).toBe(0);
			}
			expect(cluster.clock.pendingTaskCount()).toBe(0);
		} finally {
			await cluster.close();
		}
	});
});
