import { expect, it, vi } from "vitest";
import type { V1Pod } from "../gen/models";
import { kubernetes } from "../../test/harnesses/kubernetes";

const IMAGE = "crccheck/hello-world:latest";

kubernetes.describe("NodePort", ({ core, discovery, getSuiteNamespace, fetchNodePort }) => {
	it("should run a pod and reach it through a NodePort service", async () => {
		const namespace = await getSuiteNamespace();

		await core.createNamespacedPod({
			namespace,
			body: {
				metadata: {
					name: "hello-world",
					labels: { app: "hello-world" },
				},
				spec: {
					containers: [
						{
							name: "hello-world",
							image: IMAGE,
							ports: [{ name: "http", containerPort: 8000 }],
						},
					],
				},
			},
		});

		const service = await core.createNamespacedService({
			namespace,
			body: {
				metadata: {
					name: "hello-world",
				},
				spec: {
					type: "NodePort",
					selector: { app: "hello-world" },
					ports: [{ name: "http", port: 80, targetPort: "http" }],
				},
			},
		});
		const nodePort = service.spec?.ports?.[0]?.nodePort;
		if (nodePort === undefined) {
			throw new Error("Expected Service to allocate a NodePort");
		}

		await vi.waitFor(
			async () => {
				const pod = await core.readNamespacedPod({
					name: "hello-world",
					namespace,
				});
				expectPodReady(pod);
			},
			{ timeout: 120_000, interval: 500 },
		);

		await vi.waitFor(
			async () => {
				const slices = await discovery.listNamespacedEndpointSlice({
					namespace,
					labelSelector: "kubernetes.io/service-name=hello-world",
				});
				const slice = slices.items.find((candidate) =>
					candidate.endpoints.some((endpoint) => endpoint.conditions?.ready !== false),
				);
				expect(slice?.ports?.[0]).toMatchObject({
					name: "http",
					port: 8000,
					protocol: "TCP",
				});
			},
			{ timeout: 120_000, interval: 500 },
		);

		await vi.waitFor(
			async () => {
				const response = await fetchNodePort(nodePort, { path: "/" });
				expect(response.status).toBe(200);
				expect(response.body).toContain("Hello World");
			},
			{ timeout: 120_000, interval: 500 },
		);
	}, 180_000);

	it("should stop routing after a NodePort service is deleted", async () => {
		const namespace = await getSuiteNamespace();

		await core.createNamespacedPod({
			namespace,
			body: {
				metadata: {
					name: "delete-route",
					labels: { app: "delete-route" },
				},
				spec: {
					containers: [
						{
							name: "delete-route",
							image: IMAGE,
							ports: [{ name: "http", containerPort: 8000 }],
						},
					],
				},
			},
		});

		const service = await core.createNamespacedService({
			namespace,
			body: {
				metadata: {
					name: "delete-route",
				},
				spec: {
					type: "NodePort",
					selector: { app: "delete-route" },
					ports: [{ name: "http", port: 80, targetPort: "http" }],
				},
			},
		});
		const nodePort = service.spec?.ports?.[0]?.nodePort;
		if (nodePort === undefined) {
			throw new Error("Expected Service to allocate a NodePort");
		}

		await vi.waitFor(
			async () => {
				const response = await fetchNodePort(nodePort, { path: "/" });
				expect(response.status).toBe(200);
				expect(response.body).toContain("Hello World");
			},
			{ timeout: 120_000, interval: 500 },
		);

		await core.deleteNamespacedService({
			name: "delete-route",
			namespace,
		});

		await vi.waitFor(
			async () => {
				let rejected = false;
				try {
					await fetchNodePort(nodePort, { path: "/" });
				} catch {
					rejected = true;
				}
				expect(rejected).toBe(true);
			},
			{ timeout: 120_000, interval: 500 },
		);
	}, 180_000);
});

function expectPodReady(pod: V1Pod): void {
	expect(pod.spec?.nodeName).toBeTruthy();
	expect(pod.status?.phase).toBe("Running");
	expect(pod.status?.podIP).toBeTruthy();
	expect(pod.status?.containerStatuses?.[0]).toMatchObject({
		name: "hello-world",
		ready: true,
		started: true,
	});
}
