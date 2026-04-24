import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { V1Pod } from "../gen/models";
import type { K8s, KubeConfig } from "../types";

export function tests(k8s: K8s, config: KubeConfig) {
	async function watchAndWait<T>(
		url: string,
		queryParams: Record<string, string>,
		callback: (phase: string, obj: T) => void,
		wait: () => void,
	): Promise<void> {
		const watch = new k8s.Watch(config);
		const controller = await watch.watch(
			url,
			queryParams,
			(phase: string, obj: unknown) => {
				callback(phase, obj as T);
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
			await vi.waitFor(wait);
		} finally {
			controller?.abort();
		}
	}

	describe("Watch", () => {
		let api: InstanceType<K8s["CoreV1Api"]>;
		beforeAll(async () => {
			api = config.makeApiClient(k8s.CoreV1Api);
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
						containers: [{ name: "test", image: "rancher/pause:3.6" }],
						...pod.spec,
					},
				},
			});
			if (!resp.metadata?.name) {
				throw new Error("Failed to create pod");
			}
			return resp;
		}

		it("exports Watch and emits ADDED for created pods", async () => {
			const events: Array<{ phase: string; obj: V1Pod }> = [];

			const promise = watchAndWait(
				`/api/v1/namespaces/${namespace}/pods`,
				{},
				(phase, obj: V1Pod) => {
					events.push({ phase, obj });
				},
				() => {
					expect(events).toContainEqual({
						phase: "ADDED",
						obj: expect.objectContaining({
							metadata: expect.objectContaining({
								name: "watched-pod",
							}),
						}),
					});
				},
			);

			await createPod({ metadata: { name: "watched-pod" } });
			await promise;
		});

		it("passes labelSelector through to watch", async () => {
			const seenNames: string[] = [];
			const promise = watchAndWait(
				`/api/v1/namespaces/${namespace}/pods`,
				{ labelSelector: "app=selected" },
				(_, obj: V1Pod) => {
					seenNames.push(obj.metadata?.name ?? "");
				},
				() => {
					expect(seenNames).toContain("selected-pod");
					expect(seenNames).not.toContain("ignored-pod");
				},
			);

			await createPod({ metadata: { name: "ignored-pod", labels: { app: "ignored" } } });
			await createPod({ metadata: { name: "selected-pod", labels: { app: "selected" } } });
			await promise;
		});
	});
}
