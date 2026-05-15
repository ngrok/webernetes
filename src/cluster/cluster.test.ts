import { expect, it } from "vitest";

import { browser } from "../test/describe";
import { waitFor } from "../test/wait";
import { Cluster } from "./cluster";

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
});
