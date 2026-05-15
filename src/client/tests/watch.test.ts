import { expect, it } from "vitest";
import type { V1Pod } from "../gen/models";
import { kubernetes } from "../../test/harnesses/kubernetes";

interface WatchAndWaitOptions<T> {
	url: string;
	queryParams: Record<string, string>;
	onEvent: (phase: string, obj: T) => void;
	assert: () => void;
	act?: () => Promise<void>;
}

kubernetes.describe("Watch", ({ core, k8s, kubeConfig, helpers }) => {
	const { createPod, replacePod, getTestNamespace, waitFor } = helpers;

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
			await waitFor(assert);
		} finally {
			controller?.abort();
		}
	}

	it("exports Watch and emits ADDED for created pods", async () => {
		const events: Array<{ phase: string; obj: V1Pod }> = [];
		const namespace = await getTestNamespace();

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
		const namespace = await getTestNamespace();
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

	it("passes fieldSelector through to watch", async () => {
		const seenNames: string[] = [];
		const namespace = await getTestNamespace();
		const node = (await core.listNode()).items.find((candidate) => candidate.metadata?.name);
		if (!node?.metadata?.name) {
			throw new Error("Expected at least one node");
		}
		const nodeName = node.metadata.name;

		await watchAndWait({
			url: `/api/v1/namespaces/${namespace}/pods`,
			queryParams: { fieldSelector: `spec.nodeName=${nodeName}` },
			onEvent: (_, obj: V1Pod) => {
				seenNames.push(obj.metadata?.name ?? "");
			},
			assert: () => {
				expect(seenNames).toContain("selected-node-pod");
				expect(seenNames).not.toContain("other-node-pod");
			},
			act: async () => {
				await createPod({
					metadata: { name: "other-node-pod" },
					spec: {
						containers: [{ name: "test", image: "registry.k8s.io/pause:3.10" }],
						nodeName: "other-node",
					},
				});
				await createPod({
					metadata: { name: "selected-node-pod" },
					spec: {
						containers: [{ name: "test", image: "registry.k8s.io/pause:3.10" }],
						nodeName,
					},
				});
			},
		});
	});

	it("emits DELETED for deleted pods", async () => {
		const events: Array<{ phase: string; obj: V1Pod }> = [];
		const namespace = await getTestNamespace();
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
				await core.deleteNamespacedPod({
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
		const namespace = await getTestNamespace();
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

	it("continues from a list resourceVersion and does not miss later pod updates", async () => {
		const namespace = await getTestNamespace();
		const podName = "resource-version-pod";
		await createPod({
			metadata: {
				name: podName,
				labels: { revision: "initial" },
			},
		});
		const listed = await core.listNamespacedPod({
			namespace,
			fieldSelector: `metadata.name=${podName}`,
		});
		const listResourceVersion = listed.metadata?.resourceVersion;
		const listedPodResourceVersion = listed.items[0]?.metadata?.resourceVersion;
		if (!listResourceVersion || !listedPodResourceVersion) {
			throw new Error("Expected list and item resourceVersions");
		}

		await replacePod(podName, (current) => {
			current.metadata = {
				...current.metadata,
				labels: { revision: "updated-after-list" },
			};
		});

		const events: Array<{ phase: string; obj: V1Pod }> = [];
		await watchAndWait({
			url: `/api/v1/namespaces/${namespace}/pods`,
			queryParams: {
				resourceVersion: listResourceVersion,
				fieldSelector: `metadata.name=${podName}`,
			},
			onEvent: (phase, obj: V1Pod) => {
				events.push({ phase, obj });
			},
			assert: () => {
				expect(events).toContainEqual({
					phase: "MODIFIED",
					obj: expect.objectContaining({
						metadata: expect.objectContaining({
							namespace,
							name: podName,
							labels: expect.objectContaining({
								revision: "updated-after-list",
							}),
						}),
					}),
				});
				const modified = events.find(
					(event) =>
						event.phase === "MODIFIED" &&
						event.obj.metadata?.labels?.revision === "updated-after-list",
				);
				expect(modified?.obj.metadata?.resourceVersion).toBeTruthy();
				expect(modified?.obj.metadata?.resourceVersion).not.toBe(listedPodResourceVersion);
			},
		});
	});
});
