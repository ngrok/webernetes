import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { V1Pod } from "../gen/models";
import { K8s, KubeConfig } from "../types";

export interface NodePortRequest {
	method?: string;
	path?: string;
	headers?: Record<string, string>;
	body?: string;
}

export interface NodePortResponse {
	status: number;
	body?: string;
	headers?: Record<string, string>;
}

export type SendNodePortRequest = (
	nodePort: number,
	request?: NodePortRequest,
) => Promise<NodePortResponse>;

export interface NodePortTestOptions {
	sendNodePortRequest: SendNodePortRequest;
}

const IMAGE = "crccheck/hello-world:latest";

export function tests(k8s: K8s, config: KubeConfig, options: NodePortTestOptions) {
	describe("NodePort", () => {
		let api: InstanceType<typeof k8s.CoreV1Api>;
		let discoveryApi: InstanceType<typeof k8s.DiscoveryV1Api>;
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
			discoveryApi = config.makeApiClient(k8s.DiscoveryV1Api);
			namespace = await createNamespace("nodeport-test-");
		});

		afterAll(async () => {
			await api.deleteNamespace({
				name: namespace,
			});
		});

		it("should run a pod and reach it through a NodePort service", async () => {
			await api.createNamespacedPod({
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

			const service = await api.createNamespacedService({
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
					const pod = await api.readNamespacedPod({
						name: "hello-world",
						namespace,
					});
					expectPodReady(pod);
				},
				{ timeout: 120_000, interval: 500 },
			);

			await vi.waitFor(
				async () => {
					const slices = await discoveryApi.listNamespacedEndpointSlice({
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
					const response = await options.sendNodePortRequest(nodePort, { path: "/" });
					expect(response.status).toBe(200);
					expect(response.body).toContain("Hello World");
				},
				{ timeout: 120_000, interval: 500 },
			);
		}, 180_000);

		it("should stop routing after a NodePort service is deleted", async () => {
			await api.createNamespacedPod({
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

			const service = await api.createNamespacedService({
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
					const response = await options.sendNodePortRequest(nodePort, { path: "/" });
					expect(response.status).toBe(200);
					expect(response.body).toContain("Hello World");
				},
				{ timeout: 120_000, interval: 500 },
			);

			await api.deleteNamespacedService({
				name: "delete-route",
				namespace,
			});

			await vi.waitFor(
				async () => {
					let rejected = false;
					try {
						await options.sendNodePortRequest(nodePort, { path: "/" });
					} catch {
						rejected = true;
					}
					expect(rejected).toBe(true);
				},
				{ timeout: 120_000, interval: 500 },
			);
		}, 180_000);
	});
}

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
