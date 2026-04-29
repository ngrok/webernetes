import { expect, it, vi } from "vitest";
import { CIDR } from "../../net";
import type { V1Pod } from "../gen/models";
import { kubernetes } from "../../test/harnesses/kubernetes";

kubernetes.describe("Pods", ({ core, getSuiteNamespace, createNamespace }) => {
	const podImage = "registry.k8s.io/pause:3.10";

	async function createPod(pod: Partial<V1Pod>, podNamespace?: string): Promise<V1Pod> {
		const namespace = podNamespace ?? (await getSuiteNamespace());
		return await core.createNamespacedPod({
			namespace,
			body: {
				metadata: {
					...pod.metadata,
				},
				spec: {
					...pod.spec,
					containers: [{ name: "test", image: podImage }],
				},
				...pod,
			},
		});
	}

	async function replacePod(name: string, mutate: (pod: V1Pod) => void): Promise<V1Pod> {
		let lastError: unknown;
		const namespace = await getSuiteNamespace();

		for (let attempt = 0; attempt < 5; attempt++) {
			const current = await core.readNamespacedPod({ name, namespace });
			mutate(current);

			try {
				return await core.replaceNamespacedPod({
					name,
					namespace,
					body: current,
				});
			} catch (error) {
				if (
					error instanceof Error &&
					(error.message.includes("HTTP-Code: 409") ||
						(error.message.includes("HTTP-Code: 422") && error.message.includes("NodeName")))
				) {
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
			core.createNamespacedPod({
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
		const namespace = await getSuiteNamespace();

		const deleted = await core.deleteNamespacedPod({
			name: "delete-test",
			namespace,
			gracePeriodSeconds: 0,
			body: {
				gracePeriodSeconds: 0,
			},
		});

		expect(deleted.metadata?.name).toBe("delete-test");

		await vi.waitFor(async () => {
			const pods = await core.listNamespacedPod({ namespace });
			expect(pods.items.find((pod) => pod.metadata?.name === "delete-test")).toBeUndefined();
		});
	});

	it("should be able to read a pod", async () => {
		await createPod({ metadata: { name: "read-test" } });
		const namespace = await getSuiteNamespace();

		const pod = await core.readNamespacedPod({
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

		const namespace = await getSuiteNamespace();
		const pods = await core.listNamespacedPod({ namespace });
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

		const namespace = await getSuiteNamespace();
		const stale = await core.readNamespacedPod({
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
			core.replaceNamespacedPod({
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

		const current = await core.readNamespacedPod({
			name: "replace-conflict-test",
			namespace,
		});
		expect(current.metadata?.labels?.app).toBe("fresh");
	});

	it("should default pods without metadata.namespace to the default namespace", async () => {
		const pod = await core.createNamespacedPod({
			namespace: "default",
			body: {
				metadata: {
					generateName: "default-namespace-test-",
				},
				spec: {
					containers: [{ name: "test", image: podImage }],
				},
			},
		});

		if (!pod.metadata?.name) {
			throw new Error("Failed to create pod");
		}

		try {
			expect(pod.metadata.namespace).toBe("default");

			const current = await core.readNamespacedPod({
				name: pod.metadata.name,
				namespace: "default",
			});

			expect(current.metadata?.namespace).toBe("default");
		} finally {
			await core.deleteNamespacedPod({
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
		const namespace = await getSuiteNamespace();
		const otherNamespace = await createNamespace("list-all-namespaces-");
		const podName = "list-all-primary";
		const otherPodName = "list-all-secondary";

		await createPod({ metadata: { name: podName } });
		await createPod({ metadata: { name: otherPodName } }, otherNamespace);

		try {
			const pods = await core.listPodForAllNamespaces();

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
			await core.deleteNamespacedPod({
				name: otherPodName,
				namespace: otherNamespace,
				gracePeriodSeconds: 0,
				body: {
					gracePeriodSeconds: 0,
				},
			});
			await core.deleteNamespacedPod({
				name: podName,
				namespace,
				gracePeriodSeconds: 0,
				body: {
					gracePeriodSeconds: 0,
				},
			});
			await core.deleteNamespace({
				name: otherNamespace,
			});
		}
	});

	it("should support label selectors when listing pods across namespaces", async () => {
		const namespace = await getSuiteNamespace();
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
			const pods = await core.listPodForAllNamespaces({
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
			await core.deleteNamespacedPod({
				name: ignoredPodName,
				namespace: otherNamespace,
				gracePeriodSeconds: 0,
				body: {
					gracePeriodSeconds: 0,
				},
			});
			await core.deleteNamespacedPod({
				name: otherSelectedPodName,
				namespace: otherNamespace,
				gracePeriodSeconds: 0,
				body: {
					gracePeriodSeconds: 0,
				},
			});
			await core.deleteNamespacedPod({
				name: selectedPodName,
				namespace,
				gracePeriodSeconds: 0,
				body: {
					gracePeriodSeconds: 0,
				},
			});
			await core.deleteNamespace({
				name: otherNamespace,
			});
		}
	});

	it("should allocate pod IPs from the scheduled node pod CIDR", async () => {
		const namespace = await getSuiteNamespace();
		const nodes = (await core.listNode()).items.filter((node) =>
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
				await core.createNamespacedPod({
					namespace,
					body: {
						metadata: { name },
						spec: {
							nodeName,
							automountServiceAccountToken: false,
							containers: [{ name: "test", image: podImage }],
						},
					},
				});
				createdPods.push({ name, namespace });

				await vi.waitFor(
					async () => {
						const pod = await core.readNamespacedPod({ name, namespace });
						expect(pod.status?.phase).toBe("Running");
						expect(pod.status?.podIP).toBeTruthy();
						expect(cidr.contains(pod.status?.podIP ?? "")).toBe(true);
					},
					{ timeout: 10_000, interval: 500 },
				);
			}
		} finally {
			for (const pod of createdPods) {
				await core.deleteNamespacedPod({
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
