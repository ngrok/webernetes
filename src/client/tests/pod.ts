import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { V1Pod } from "../gen/models";
import { K8s, KubeConfig } from "../types";

export function tests(k8s: K8s, config: KubeConfig) {
	describe("Pods", () => {
		let api: InstanceType<typeof k8s.CoreV1Api>;
		let namespace: string;

		beforeAll(async () => {
			api = config.makeApiClient(k8s.CoreV1Api);

			const resp = await api.createNamespace({
				body: {
					metadata: {
						generateName: "test-",
					},
				},
			});

			if (!resp.metadata?.name) {
				throw new Error("Failed to create namespace");
			}

			namespace = resp.metadata.name;
		});

		afterAll(async () => {
			await api.deleteNamespace({
				name: namespace,
			});
		});

		async function createPod(pod: Partial<V1Pod>): Promise<V1Pod> {
			return await api.createNamespacedPod({
				namespace,
				body: {
					metadata: {
						...pod.metadata,
					},
					spec: {
						...pod.spec,
						containers: [{ name: "test", image: "rancher/pause:3.6" }],
					},
					...pod,
				},
			});
		}

		async function replacePod(name: string, mutate: (pod: V1Pod) => void): Promise<V1Pod> {
			let lastError: unknown;

			for (let attempt = 0; attempt < 5; attempt++) {
				const current = await api.readNamespacedPod({ name, namespace });
				mutate(current);

				try {
					return await api.replaceNamespacedPod({
						name,
						namespace,
						body: current,
					});
				} catch (error) {
					if (error instanceof Error && error.message.includes("HTTP-Code: 409")) {
						lastError = error;
						await new Promise((resolve) => setTimeout(resolve, 50));
						continue;
					}
					throw error;
				}
			}

			throw lastError ?? new Error(`Failed to replace pod ${name}`);
		}

		it("should be able to create a pod", async () => {
			const pod = await createPod({ metadata: { name: "create-test" } });
			expect(pod.metadata?.name).toBe("create-test");
		});

		it("should not be able to create a pod in a namespace that does not exist", async () => {
			await expect(
				api.createNamespacedPod({
					namespace: "non-existent-namespace",
					body: {
						metadata: {
							namespace: "non-existent-namespace",
							name: "test",
						},
						spec: {
							containers: [{ name: "test", image: "pause" }],
						},
					},
				}),
			).rejects.toThrow(/NotFound/);
		});

		it("should be able to delete a pod", async () => {
			await createPod({ metadata: { name: "delete-test" } });

			const deleted = await api.deleteNamespacedPod({
				name: "delete-test",
				namespace,
				gracePeriodSeconds: 0,
				body: {
					gracePeriodSeconds: 0,
				},
			});

			expect(deleted.metadata?.name).toBe("delete-test");

			await vi.waitFor(async () => {
				const pods = await api.listNamespacedPod({ namespace });
				expect(pods.items.find((pod) => pod.metadata?.name === "delete-test")).toBeUndefined();
			});
		});

		it("should be able to read a pod", async () => {
			await createPod({ metadata: { name: "read-test" } });

			const pod = await api.readNamespacedPod({
				name: "read-test",
				namespace,
			});

			expect(pod.metadata?.name).toBe("read-test");
		});

		it("should be able to replace a pod", async () => {
			await createPod({
				metadata: {
					name: "replace-test",
					labels: { app: "original" },
				},
			});

			const replaced = await replacePod("replace-test", (current) => {
				current.metadata = {
					name: "replace-test",
					labels: { app: "replaced" },
				};
			});

			expect(replaced.metadata?.labels?.app).toBe("replaced");

			const pods = await api.listNamespacedPod({ namespace });
			expect(
				pods.items.find((pod) => pod.metadata?.name === "replace-test")?.metadata?.labels?.app,
			).toBe("replaced");
		});

		it("should throw 409 when replacing a pod with a stale resourceVersion", async () => {
			await createPod({
				metadata: {
					name: "replace-conflict-test",
					labels: { app: "original" },
				},
			});

			const stale = await api.readNamespacedPod({
				name: "replace-conflict-test",
				namespace,
			});

			expect(stale.metadata?.resourceVersion).toBeTruthy();

			await replacePod("replace-conflict-test", (current) => {
				current.metadata = {
					...current.metadata,
					name: "replace-conflict-test",
					labels: { app: "fresh" },
				};
			});

			await expect(
				api.replaceNamespacedPod({
					name: "replace-conflict-test",
					namespace,
					body: {
						...stale,
						metadata: {
							...stale.metadata,
							labels: { app: "stale" },
						},
					},
				}),
			).rejects.toThrow(/HTTP-Code: 409/);

			const current = await api.readNamespacedPod({
				name: "replace-conflict-test",
				namespace,
			});
			expect(current.metadata?.labels?.app).toBe("fresh");
		});
	});
}
