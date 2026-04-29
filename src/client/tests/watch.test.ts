import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { V1Pod } from "../gen/models";
import { kubernetes } from "../../test/harnesses/kubernetes";

interface WatchAndWaitOptions<T> {
	url: string;
	queryParams: Record<string, string>;
	onEvent: (phase: string, obj: T) => void;
	assert: () => void;
	act?: () => Promise<void>;
}

kubernetes.describe("Watch", ({ k8s, kubeConfig }) => {
	async function watchAndWait<T>({
		url,
		queryParams,
		onEvent,
		assert,
		act,
	}: WatchAndWaitOptions<T>): Promise<void> {
		const watch = new k8s.Watch(kubeConfig);
		const controller = await watch.watch(
			url,
			queryParams,
			(phase: string, obj: unknown) => {
				onEvent(phase, obj as T);
			},
			(err) => {
				if (err instanceof Error) {
					if (err.name === "AbortError") {
						return;
					}
					throw err;
				}
			},
		);

		try {
			await act?.();
			await vi.waitFor(assert);
		} finally {
			controller?.abort();
		}
	}

	let api: InstanceType<typeof k8s.CoreV1Api>;
	beforeAll(async () => {
		api = kubeConfig.makeApiClient(k8s.CoreV1Api);
	});

	let namespace: string;
	beforeEach(async () => {
		const resp = await api.createNamespace({
			body: {
				metadata: {
					generateName: "watch-test-",
				},
			},
		});

		if (!resp.metadata?.name) {
			throw new Error("Failed to create namespace");
		}
		namespace = resp.metadata.name;
	});

	afterEach(async () => {
		await api.deleteNamespace({ name: namespace });
	});

	async function createPod(pod: Partial<V1Pod>): Promise<V1Pod> {
		const resp = await api.createNamespacedPod({
			namespace,
			body: {
				metadata: {
					name: pod.metadata?.name ?? "test-pod",
					...pod.metadata,
				},
				spec: {
					containers: [{ name: "test", image: "registry.k8s.io/pause:3.10" }],
					...pod.spec,
				},
			},
		});
		if (!resp.metadata?.name) {
			throw new Error("Failed to create pod");
		}
		return resp;
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

	it("exports Watch and emits ADDED for created pods", async () => {
		const events: Array<{ phase: string; obj: V1Pod }> = [];

		await watchAndWait({
			url: `/api/v1/namespaces/${namespace}/pods`,
			queryParams: {},
			onEvent: (phase, obj: V1Pod) => {
				events.push({ phase, obj });
			},
			assert: () => {
				expect(events).toContainEqual({
					phase: "ADDED",
					obj: expect.objectContaining({
						metadata: expect.objectContaining({
							namespace,
							name: "watched-pod",
						}),
					}),
				});
			},
			act: async () => {
				await createPod({ metadata: { name: "watched-pod" } });
			},
		});
	});

	it("passes labelSelector through to watch", async () => {
		const seenNames: string[] = [];
		await watchAndWait({
			url: `/api/v1/namespaces/${namespace}/pods`,
			queryParams: { labelSelector: "app=selected" },
			onEvent: (_, obj: V1Pod) => {
				seenNames.push(obj.metadata?.name ?? "");
			},
			assert: () => {
				expect(seenNames).toContain("selected-pod");
				expect(seenNames).not.toContain("ignored-pod");
			},
			act: async () => {
				await createPod({ metadata: { name: "ignored-pod", labels: { app: "ignored" } } });
				await createPod({ metadata: { name: "selected-pod", labels: { app: "selected" } } });
			},
		});
	});

	it("emits DELETED for deleted pods", async () => {
		const events: Array<{ phase: string; obj: V1Pod }> = [];
		await createPod({ metadata: { name: "deleted-pod" } });

		await watchAndWait({
			url: `/api/v1/namespaces/${namespace}/pods`,
			queryParams: {},
			onEvent: (phase, obj: V1Pod) => {
				events.push({ phase, obj });
			},
			assert: () => {
				expect(events).toContainEqual({
					phase: "DELETED",
					obj: expect.objectContaining({
						metadata: expect.objectContaining({
							namespace,
							name: "deleted-pod",
						}),
					}),
				});
			},
			act: async () => {
				await api.deleteNamespacedPod({
					name: "deleted-pod",
					namespace,
					gracePeriodSeconds: 0,
					body: {
						gracePeriodSeconds: 0,
					},
				});
			},
		});
	});

	it("emits MODIFIED for replaced pods", async () => {
		const events: Array<{ phase: string; obj: V1Pod }> = [];
		await createPod({ metadata: { name: "modified-pod", labels: { app: "original" } } });

		await watchAndWait({
			url: `/api/v1/namespaces/${namespace}/pods`,
			queryParams: {},
			onEvent: (phase, obj: V1Pod) => {
				events.push({ phase, obj });
			},
			assert: () => {
				expect(events).toContainEqual({
					phase: "MODIFIED",
					obj: expect.objectContaining({
						metadata: expect.objectContaining({
							namespace,
							name: "modified-pod",
							labels: expect.objectContaining({
								app: "modified",
							}),
						}),
					}),
				});
			},
			act: async () => {
				await replacePod("modified-pod", (current) => {
					current.metadata = {
						name: "modified-pod",
						labels: {
							app: "modified",
						},
					};
				});
			},
		});
	});
});
