import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CIDR } from "../../net";
import type { V1Pod } from "../gen/models";
import { K8s, KubeConfig } from "../types";

export function tests(k8s: K8s, config: KubeConfig) {
	describe("Pods", () => {
		let api: InstanceType<typeof k8s.CoreV1Api>;
		let namespace: string;

		async function createNamespace(generateName: string): Promise<string> {
			const resp = await api.createNamespace({
				body: {
					metadata: {
						generateName,
					},
				},
			});

			if (!resp.metadata?.name) {
				throw new Error("Failed to create namespace");
			}

			return resp.metadata.name;
		}

		beforeAll(async () => {
			api = config.makeApiClient(k8s.CoreV1Api);

			namespace = await createNamespace("test-");
		});

		afterAll(async () => {
			await api.deleteNamespace({
				name: namespace,
			});
		});

		async function createPod(pod: Partial<V1Pod>, podNamespace = namespace): Promise<V1Pod> {
			return await api.createNamespacedPod({
				namespace: podNamespace,
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

		it("should default pods without metadata.namespace to the default namespace", async () => {
			const pod = await api.createNamespacedPod({
				namespace: "default",
				body: {
					metadata: {
						generateName: "default-namespace-test-",
					},
					spec: {
						containers: [{ name: "test", image: "rancher/pause:3.6" }],
					},
				},
			});

			if (!pod.metadata?.name) {
				throw new Error("Failed to create pod");
			}

			try {
				expect(pod.metadata.namespace).toBe("default");

				const current = await api.readNamespacedPod({
					name: pod.metadata.name,
					namespace: "default",
				});

				expect(current.metadata?.namespace).toBe("default");
			} finally {
				await api.deleteNamespacedPod({
					name: pod.metadata.name,
					namespace: "default",
					gracePeriodSeconds: 0,
					body: {
						gracePeriodSeconds: 0,
					},
				});
			}
		});

		it("should list pods across namespaces", async () => {
			const otherNamespace = await createNamespace("list-all-namespaces-");
			const podName = "list-all-primary";
			const otherPodName = "list-all-secondary";

			await createPod({ metadata: { name: podName } });
			await createPod({ metadata: { name: otherPodName } }, otherNamespace);

			try {
				const pods = await api.listPodForAllNamespaces();

				expect(pods.items).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: podName,
								namespace,
							}),
						}),
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: otherPodName,
								namespace: otherNamespace,
							}),
						}),
					]),
				);
			} finally {
				await api.deleteNamespacedPod({
					name: otherPodName,
					namespace: otherNamespace,
					gracePeriodSeconds: 0,
					body: {
						gracePeriodSeconds: 0,
					},
				});
				await api.deleteNamespacedPod({
					name: podName,
					namespace,
					gracePeriodSeconds: 0,
					body: {
						gracePeriodSeconds: 0,
					},
				});
				await api.deleteNamespace({
					name: otherNamespace,
				});
			}
		});

		it("should support label selectors when listing pods across namespaces", async () => {
			const otherNamespace = await createNamespace("list-all-selected-");
			const selectedPodName = "list-all-selected-primary";
			const otherSelectedPodName = "list-all-selected-secondary";
			const ignoredPodName = "list-all-ignored";

			await createPod({
				metadata: {
					name: selectedPodName,
					labels: { app: "selected" },
				},
			});
			await createPod(
				{
					metadata: {
						name: otherSelectedPodName,
						labels: { app: "selected" },
					},
				},
				otherNamespace,
			);
			await createPod(
				{
					metadata: {
						name: ignoredPodName,
						labels: { app: "ignored" },
					},
				},
				otherNamespace,
			);

			try {
				const pods = await api.listPodForAllNamespaces({
					labelSelector: "app=selected",
				});

				expect(pods.items).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: selectedPodName,
								namespace,
								labels: expect.objectContaining({
									app: "selected",
								}),
							}),
						}),
						expect.objectContaining({
							metadata: expect.objectContaining({
								name: otherSelectedPodName,
								namespace: otherNamespace,
								labels: expect.objectContaining({
									app: "selected",
								}),
							}),
						}),
					]),
				);
				expect(
					pods.items.find(
						(pod) =>
							pod.metadata?.name === ignoredPodName && pod.metadata?.namespace === otherNamespace,
					),
				).toBeUndefined();
			} finally {
				await api.deleteNamespacedPod({
					name: ignoredPodName,
					namespace: otherNamespace,
					gracePeriodSeconds: 0,
					body: {
						gracePeriodSeconds: 0,
					},
				});
				await api.deleteNamespacedPod({
					name: otherSelectedPodName,
					namespace: otherNamespace,
					gracePeriodSeconds: 0,
					body: {
						gracePeriodSeconds: 0,
					},
				});
				await api.deleteNamespacedPod({
					name: selectedPodName,
					namespace,
					gracePeriodSeconds: 0,
					body: {
						gracePeriodSeconds: 0,
					},
				});
				await api.deleteNamespace({
					name: otherNamespace,
				});
			}
		});

		it("should allocate pod IPs from the scheduled node pod CIDR", async () => {
			const nodes = (await api.listNode()).items.filter((node) =>
				Boolean(node.metadata?.name && node.spec?.podCIDR),
			);
			expect(nodes.length).toBeGreaterThan(0);

			const createdPods: Array<{ name: string; namespace: string }> = [];

			try {
				for (const [index, node] of nodes.entries()) {
					const nodeName = node.metadata?.name;
					const podCIDR = node.spec?.podCIDR;
					if (!nodeName || !podCIDR) {
						continue;
					}
					const cidr = new CIDR(podCIDR);

					const name = `node-cidr-${index}`;
					await api.createNamespacedPod({
						namespace,
						body: {
							metadata: { name },
							spec: {
								nodeName,
								containers: [{ name: "test", image: "rancher/pause:3.6" }],
							},
						},
					});
					createdPods.push({ name, namespace });

					await vi.waitFor(async () => {
						const pod = await api.readNamespacedPod({ name, namespace });
						expect(pod.status?.phase).toBe("Running");
						expect(pod.status?.podIP).toBeTruthy();
						expect(cidr.contains(pod.status?.podIP ?? "")).toBe(true);
					});
				}
			} finally {
				for (const pod of createdPods) {
					await api.deleteNamespacedPod({
						name: pod.name,
						namespace: pod.namespace,
						gracePeriodSeconds: 0,
						body: {
							gracePeriodSeconds: 0,
						},
					});
				}
			}
		});
	});
}
