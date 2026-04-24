import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { V1Pod } from "../gen/models";
import type { K8s, KubeConfig } from "../types";

export function tests(k8s: K8s, config: KubeConfig) {
	describe("Informer", () => {
		let api: InstanceType<K8s["CoreV1Api"]>;
		let namespace: string;

		beforeAll(async () => {
			api = config.makeApiClient(k8s.CoreV1Api);
		});

		beforeEach(async () => {
			const response = await api.createNamespace({
				body: {
					metadata: {
						generateName: "informer-test-",
					},
				},
			});

			if (!response.metadata?.name) {
				throw new Error("Failed to create namespace");
			}

			namespace = response.metadata.name;
		});

		afterEach(async () => {
			await api.deleteNamespace({ name: namespace });
		});

		async function createPod(pod: Partial<V1Pod>): Promise<V1Pod> {
			const response = await api.createNamespacedPod({
				namespace,
				body: {
					metadata: {
						name: pod.metadata?.name ?? "test-pod",
						...pod.metadata,
					},
					spec: {
						containers: [{ name: "test", image: "rancher/pause:3.6" }],
						...pod.spec,
					},
				},
			});

			if (!response.metadata?.name) {
				throw new Error("Failed to create pod");
			}

			return response;
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

		it("lists initial objects into the cache on start", async () => {
			await createPod({ metadata: { name: "existing-pod" } });

			const informer = k8s.makeInformer(config, `/api/v1/namespaces/${namespace}/pods`, () =>
				api.listNamespacedPod({ namespace }),
			);

			try {
				await informer.start();

				await vi.waitFor(() => {
					expect(informer.get("existing-pod", namespace)).toEqual(
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: "existing-pod",
								namespace,
							}),
						}),
					);
					expect(informer.list(namespace)).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								metadata: expect.objectContaining({
									name: "existing-pod",
								}),
							}),
						]),
					);
				});
			} finally {
				await informer.stop();
			}
		});

		it("updates the cache and emits add, update, and delete events", async () => {
			const added = vi.fn<(obj: V1Pod) => void>();
			const updated = vi.fn<(obj: V1Pod) => void>();
			const deleted = vi.fn<(obj: V1Pod) => void>();

			const informer = k8s.makeInformer(config, `/api/v1/namespaces/${namespace}/pods`, () =>
				api.listNamespacedPod({ namespace }),
			);
			informer.on("add", added);
			informer.on("update", updated);
			informer.on("delete", deleted);

			try {
				await informer.start();

				await createPod({ metadata: { name: "informer-pod", labels: { app: "v1" } } });
				await vi.waitFor(() => {
					expect(added).toHaveBeenCalledWith(
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: "informer-pod",
								namespace,
							}),
						}),
					);
					expect(informer.get("informer-pod", namespace)).toEqual(
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: "informer-pod",
							}),
						}),
					);
				});

				await replacePod("informer-pod", (current) => {
					current.metadata = {
						...current.metadata,
						name: "informer-pod",
						namespace,
						labels: { app: "v2" },
					};
				});
				await vi.waitFor(() => {
					expect(updated).toHaveBeenCalledWith(
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: "informer-pod",
								labels: expect.objectContaining({
									app: "v2",
								}),
							}),
						}),
					);
					expect(informer.get("informer-pod", namespace)?.metadata?.labels?.app).toBe("v2");
				});

				await api.deleteNamespacedPod({
					name: "informer-pod",
					namespace,
					gracePeriodSeconds: 0,
					body: { gracePeriodSeconds: 0 },
				});
				await vi.waitFor(() => {
					expect(deleted).toHaveBeenCalledWith(
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: "informer-pod",
								namespace,
							}),
						}),
					);
					expect(informer.get("informer-pod", namespace)).toBeUndefined();
				});
			} finally {
				await informer.stop();
			}
		});

		it("supports label selectors via list and watch", async () => {
			const addedNames: string[] = [];

			const informer = k8s.makeInformer(
				config,
				`/api/v1/namespaces/${namespace}/pods`,
				() => api.listNamespacedPod({ namespace, labelSelector: "app=selected" }),
				"app=selected",
			);
			informer.on("add", (obj) => {
				addedNames.push(obj.metadata?.name ?? "");
			});

			try {
				await createPod({ metadata: { name: "ignored-pod", labels: { app: "ignored" } } });
				await createPod({ metadata: { name: "selected-pod", labels: { app: "selected" } } });

				await informer.start();

				await vi.waitFor(() => {
					expect(informer.get("selected-pod", namespace)).toEqual(
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: "selected-pod",
							}),
						}),
					);
					expect(informer.get("ignored-pod", namespace)).toBeUndefined();
					expect(addedNames).toContain("selected-pod");
					expect(addedNames).not.toContain("ignored-pod");
				});
			} finally {
				await informer.stop();
			}
		});
	});
}
