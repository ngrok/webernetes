import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { V1Pod } from "../gen/models";
import type { K8s, KubeConfig } from "../types";

export function tests(k8s: K8s, config: KubeConfig) {
	describe("Informer", () => {
		let api: InstanceType<K8s["CoreV1Api"]>;
		let namespace: string;

		async function createNamespace(generateName: string): Promise<string> {
			const response = await api.createNamespace({
				body: {
					metadata: {
						generateName,
					},
				},
			});

			if (!response.metadata?.name) {
				throw new Error("Failed to create namespace");
			}

			return response.metadata.name;
		}

		beforeAll(async () => {
			api = config.makeApiClient(k8s.CoreV1Api);
		});

		beforeEach(async () => {
			namespace = await createNamespace("informer-test-");
		});

		afterEach(async () => {
			await api.deleteNamespace({ name: namespace });
		});

		async function createPod(pod: Partial<V1Pod>, podNamespace = namespace): Promise<V1Pod> {
			const response = await api.createNamespacedPod({
				namespace: podNamespace,
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

		async function replacePod(
			name: string,
			mutate: (pod: V1Pod) => void,
			podNamespace = namespace,
		): Promise<V1Pod> {
			let lastError: unknown;

			for (let attempt = 0; attempt < 5; attempt++) {
				const current = await api.readNamespacedPod({ name, namespace: podNamespace });
				mutate(current);

				try {
					return await api.replaceNamespacedPod({
						name,
						namespace: podNamespace,
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
			const connected = vi.fn<(err?: unknown) => void>();
			const added = vi.fn<(obj: V1Pod) => void>();

			await createPod({ metadata: { name: "existing-pod" } });

			const informer = k8s.makeInformer(config, `/api/v1/namespaces/${namespace}/pods`, () =>
				api.listNamespacedPod({ namespace }),
			);
			informer.on("connect", connected);
			informer.on("add", added);

			try {
				await informer.start();

				await vi.waitFor(() => {
					expect(connected).toHaveBeenCalledTimes(1);
					expect(added).toHaveBeenCalledWith(
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: "existing-pod",
								namespace,
							}),
						}),
					);
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

		it("supports change handlers and removing them with off", async () => {
			const changed = vi.fn<(obj: V1Pod) => void>();
			const added = vi.fn<(obj: V1Pod) => void>();
			const updated = vi.fn<(obj: V1Pod) => void>();
			const deleted = vi.fn<(obj: V1Pod) => void>();

			const informer = k8s.makeInformer(config, `/api/v1/namespaces/${namespace}/pods`, () =>
				api.listNamespacedPod({ namespace }),
			);
			informer.on("change", changed);
			informer.on("add", added);
			informer.on("update", updated);
			informer.on("delete", deleted);

			try {
				await informer.start();

				await createPod({ metadata: { name: "change-pod", labels: { app: "v1" } } });
				await vi.waitFor(() => {
					expect(changed).toHaveBeenCalledWith(
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: "change-pod",
								namespace,
							}),
						}),
					);
				});
				const changeCallsAfterAdd = changed.mock.calls.length;

				await replacePod("change-pod", (current) => {
					current.metadata = {
						...current.metadata,
						labels: { app: "v2" },
					};
				});
				await vi.waitFor(() => {
					expect(changed.mock.calls.length).toBeGreaterThan(changeCallsAfterAdd);
					expect(changed).toHaveBeenCalledWith(
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: "change-pod",
								labels: expect.objectContaining({
									app: "v2",
								}),
							}),
						}),
					);
				});
				const changeCallsAfterUpdate = changed.mock.calls.length;

				await api.deleteNamespacedPod({
					name: "change-pod",
					namespace,
					gracePeriodSeconds: 0,
					body: { gracePeriodSeconds: 0 },
				});

				await vi.waitFor(() => {
					expect(changed.mock.calls.length).toBeGreaterThan(changeCallsAfterUpdate);
				});

				informer.off("change", changed);
				const changeCallsBeforeOff = changed.mock.calls.length;
				added.mockClear();
				updated.mockClear();
				deleted.mockClear();

				await createPod({ metadata: { name: "second-change-pod", labels: { app: "v1" } } });
				await replacePod("second-change-pod", (current) => {
					current.metadata = {
						...current.metadata,
						name: "second-change-pod",
						namespace,
						labels: { app: "v2" },
					};
				});
				await api.deleteNamespacedPod({
					name: "second-change-pod",
					namespace,
					gracePeriodSeconds: 0,
					body: { gracePeriodSeconds: 0 },
				});

				await vi.waitFor(() => {
					expect(added).toHaveBeenCalledWith(
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: "second-change-pod",
								namespace,
							}),
						}),
					);
					expect(updated).toHaveBeenCalledWith(
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: "second-change-pod",
								labels: expect.objectContaining({
									app: "v2",
								}),
							}),
						}),
					);
					expect(deleted).toHaveBeenCalledWith(
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: "second-change-pod",
								namespace,
							}),
						}),
					);
					expect(changed).toHaveBeenCalledTimes(changeCallsBeforeOff);
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

		it("resyncs objects created while stopped after restarting", async () => {
			const connected = vi.fn<(err?: unknown) => void>();

			const informer = k8s.makeInformer(config, `/api/v1/namespaces/${namespace}/pods`, () =>
				api.listNamespacedPod({ namespace }),
			);
			informer.on("connect", connected);

			try {
				await informer.start();

				await vi.waitFor(() => {
					expect(connected).toHaveBeenCalledTimes(1);
				});

				await informer.stop();
				await createPod({ metadata: { name: "created-while-stopped" } });

				await informer.start();

				await vi.waitFor(() => {
					expect(connected).toHaveBeenCalledTimes(2);
					expect(informer.get("created-while-stopped", namespace)).toEqual(
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: "created-while-stopped",
								namespace,
							}),
						}),
					);
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

		it("tracks objects entering and leaving a label-selected informer", async () => {
			const added = vi.fn<(obj: V1Pod) => void>();
			const deleted = vi.fn<(obj: V1Pod) => void>();

			const informer = k8s.makeInformer(
				config,
				`/api/v1/namespaces/${namespace}/pods`,
				() => api.listNamespacedPod({ namespace, labelSelector: "app=selected" }),
				"app=selected",
			);
			informer.on("add", added);
			informer.on("delete", deleted);

			try {
				await informer.start();
				await createPod({ metadata: { name: "switching-pod", labels: { app: "ignored" } } });

				await replacePod("switching-pod", (current) => {
					current.metadata = {
						...current.metadata,
						name: "switching-pod",
						namespace,
						labels: { app: "selected" },
					};
				});

				await vi.waitFor(() => {
					expect(added).toHaveBeenCalledWith(
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: "switching-pod",
								namespace,
								labels: expect.objectContaining({
									app: "selected",
								}),
							}),
						}),
					);
					expect(informer.get("switching-pod", namespace)?.metadata?.labels?.app).toBe("selected");
				});

				await replacePod("switching-pod", (current) => {
					current.metadata = {
						...current.metadata,
						name: "switching-pod",
						namespace,
						labels: { app: "ignored" },
					};
				});

				await vi.waitFor(() => {
					expect(deleted).toHaveBeenCalledWith(
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: "switching-pod",
								namespace,
							}),
						}),
					);
					expect(informer.get("switching-pod", namespace)).toBeUndefined();
				});
			} finally {
				await informer.stop();
			}
		});

		it("lists cluster-wide informer objects across namespaces", async () => {
			const otherNamespace = await createNamespace("informer-secondary-");
			const podName = "shared-name";

			await createPod({ metadata: { name: podName } });
			await createPod({ metadata: { name: podName } }, otherNamespace);

			const informer = k8s.makeInformer(config, "/api/v1/pods", () =>
				api.listPodForAllNamespaces(),
			);

			try {
				await informer.start();

				await vi.waitFor(() => {
					expect(informer.get(podName, namespace)).toEqual(
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: podName,
								namespace,
							}),
						}),
					);
					expect(informer.get(podName, otherNamespace)).toEqual(
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: podName,
								namespace: otherNamespace,
							}),
						}),
					);
					expect(informer.list()).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								metadata: expect.objectContaining({
									name: podName,
									namespace,
								}),
							}),
							expect.objectContaining({
								metadata: expect.objectContaining({
									name: podName,
									namespace: otherNamespace,
								}),
							}),
						]),
					);
					expect(informer.list(namespace)).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								metadata: expect.objectContaining({
									name: podName,
									namespace,
								}),
							}),
						]),
					);
					expect(informer.list(otherNamespace)).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								metadata: expect.objectContaining({
									name: podName,
									namespace: otherNamespace,
								}),
							}),
						]),
					);
				});
			} finally {
				await informer.stop();
				await api.deleteNamespace({ name: otherNamespace });
			}
		});
	});
}
