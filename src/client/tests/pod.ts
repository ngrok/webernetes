import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

		it("should be able to create a pod", async () => {
			const pod = await api.createNamespacedPod({
				namespace,
				body: {
					metadata: {
						name: "test",
					},
					spec: {
						containers: [{ name: "test", image: "rancher/pause:3.6" }],
					},
				},
			});

			expect(pod.metadata?.name).toBe("test");
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
	});
}
