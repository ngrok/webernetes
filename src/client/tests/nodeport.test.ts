import { expect, it } from "vitest";
import type { V1Pod } from "../gen/models";
import { kubernetes } from "../../test/harnesses/kubernetes";

const IMAGE = "crccheck/hello-world:latest";

kubernetes.describe("NodePort", ({ core, discovery, helpers }) => {
	const { getSuiteNamespace, fetchNodePort, createPod, createNodePortFor, waitFor } = helpers;

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

		await waitFor(async () => {
			const pod = await core.readNamespacedPod({
				name: "hello-world",
				namespace,
			});
			expectPodReady(pod);
		});

		await waitForReadyEndpointSlice("hello-world", namespace, 8000);

		await waitFor(async () => {
			const response = await fetchNodePort(nodePort, { path: "/" });
			expect(response.status).toBe(200);
			expect(response.body).toContain("Hello World");
		});
	});

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

		await waitFor(async () => {
			const pod = await core.readNamespacedPod({
				name: "delete-route",
				namespace,
			});
			expectPodReady(pod);
		});

		await waitForReadyEndpointSlice("delete-route", namespace, 8000);

		await waitFor(async () => {
			const response = await fetchNodePort(nodePort, { path: "/" });
			expect(response.status).toBe(200);
			expect(response.body).toContain("Hello World");
		});

		await core.deleteNamespacedService({
			name: "delete-route",
			namespace,
		});

		await waitFor(async () => {
			let rejected = false;
			try {
				await fetchNodePort(nodePort, { path: "/", retries: 0 });
			} catch {
				rejected = true;
			}
			expect(rejected).toBe(true);
		});
	});

	it("should reject creating a NodePort for pods without a shared label", async () => {
		const first = await createPod({
			metadata: {
				name: "no-shared-label-a",
				labels: { app: "a" },
			},
			spec: {
				containers: [
					{
						name: "a",
						image: IMAGE,
						ports: [{ name: "http", containerPort: 8000 }],
					},
				],
			},
		});
		const second = await createPod({
			metadata: {
				name: "no-shared-label-b",
				labels: { app: "b" },
			},
			spec: {
				containers: [
					{
						name: "b",
						image: IMAGE,
						ports: [{ name: "http", containerPort: 8000 }],
					},
				],
			},
		});

		await expect(createNodePortFor([first, second])).rejects.toThrow(
			"Expected pods to share at least one label",
		);
	});

	async function waitForReadyEndpointSlice(
		serviceName: string,
		namespace: string,
		port: number,
	): Promise<void> {
		await waitFor(async () => {
			const slices = await discovery.listNamespacedEndpointSlice({
				namespace,
				labelSelector: `kubernetes.io/service-name=${serviceName}`,
			});
			const slice = slices.items.find((candidate) =>
				candidate.endpoints.some((endpoint) => endpoint.conditions?.ready !== false),
			);
			expect(slice?.ports?.[0]).toMatchObject({
				name: "http",
				port,
				protocol: "TCP",
			});
		});
	}
});

function expectPodReady(pod: V1Pod): void {
	expect(pod.spec?.nodeName).toBeTruthy();
	expect(pod.status?.phase).toBe("Running");
	expect(pod.status?.podIP).toBeTruthy();
	expect(pod.status?.containerStatuses?.[0]).toMatchObject({
		name: pod.metadata?.name,
		ready: true,
		started: true,
	});
}
