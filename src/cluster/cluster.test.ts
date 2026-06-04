import { expect, it } from "vitest";

import { browser } from "../test/describe";
import { waitFor } from "../test/wait";
import { Cluster } from "./cluster";

browser.describe("Cluster nodes", () => {
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
});

browser.describe("Cluster shutdown", () => {
	it("canceling cluster context exits kubelet loops without closing probe result channels", async () => {
		const cluster = new Cluster();
		await cluster.init();
		try {
			await cluster.close();

			for (const server of cluster.servers) {
				expect(server.kubelet.isSyncLoopExited()).toBe(true);
				await expect(server.kubelet.probeResultChannelsAreOpen()).resolves.toBe(true);
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
				await expect(server.kubelet.probeResultChannelsAreOpen()).resolves.toBe(true);
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
