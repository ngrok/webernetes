import { describe, expect, it } from "vitest";
import type { k8s as K8sModule } from "./index";

export function tests(k8s: K8sModule, config: InstanceType<K8sModule["KubeConfig"]>) {
	describe("Pods", () => {
		it("should be able to create a pod", async () => {
			const api = config.makeApiClient(k8s.CoreV1Api);

			const pod = await api.createNamespacedPod({
				namespace: "default",
				body: {
					metadata: {
						name: "test",
					},
					spec: {
						containers: [{ name: "test", image: "pause" }],
					},
				},
			});

			expect(pod.metadata?.name).toBe("test");
		});
	});
}
