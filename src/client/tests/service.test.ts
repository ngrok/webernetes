import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { V1Pod, V1Service } from "../gen/models";
import { kubernetes } from "../../test/harnesses/kubernetes";

kubernetes.describe("Services", ({ k8s, kubeConfig, sendNodePortRequest }) => {
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
		api = kubeConfig.makeApiClient(k8s.CoreV1Api);
		namespace = await createNamespace("service-test-");
	});

	afterAll(async () => {
		await api.deleteNamespace({
			name: namespace,
		});
	});

	async function createService(service: Partial<V1Service>): Promise<V1Service> {
		return await api.createNamespacedService({
			namespace,
			body: {
				metadata: {
					...service.metadata,
				},
				spec: {
					...service.spec,
					ports: service.spec?.ports ?? [{ port: 80 }],
				},
				...service,
			},
		});
	}

	async function createEchoPod(name: string, text: string): Promise<void> {
		await api.createNamespacedPod({
			namespace,
			body: {
				metadata: {
					name,
					labels: { app: "http-echo-lb" },
				},
				spec: {
					containers: [
						{
							name,
							image: "hashicorp/http-echo:1.0",
							env: [{ name: "ECHO_TEXT", value: text }],
							ports: [{ name: "http", containerPort: 5678 }],
						},
					],
				},
			},
		});
	}

	it("should allocate ClusterIP and NodePort values for NodePort services", async () => {
		const service = await createService({
			metadata: {
				name: "node-port-create",
			},
			spec: {
				type: "NodePort",
				selector: { app: "web" },
				ports: [{ port: 80 }],
			},
		});

		const nodePort = service.spec?.ports?.[0]?.nodePort;
		expect(service.metadata?.namespace).toBe(namespace);
		expect(service.spec?.type).toBe("NodePort");
		expect(service.spec?.clusterIP).toBeTruthy();
		expect(service.spec?.clusterIP).not.toBe("None");
		expect(service.spec?.clusterIPs?.[0]).toBe(service.spec?.clusterIP);
		expect(nodePort).toBeGreaterThan(0);
	});

	it("should preserve allocated service values across replace", async () => {
		const service = await createService({
			metadata: {
				name: "node-port-replace",
				labels: { app: "original" },
			},
			spec: {
				type: "NodePort",
				ports: [{ name: "http", port: 80 }],
			},
		});

		const replaced = await api.replaceNamespacedService({
			name: "node-port-replace",
			namespace,
			body: {
				...service,
				metadata: {
					...service.metadata,
					labels: { app: "replaced" },
				},
				spec: {
					...service.spec,
					selector: { app: "web" },
				},
			},
		});

		expect(replaced.metadata?.labels?.app).toBe("replaced");
		expect(replaced.spec?.clusterIP).toBe(service.spec?.clusterIP);
		expect(replaced.spec?.clusterIPs).toEqual(service.spec?.clusterIPs);
		expect(replaced.spec?.ports?.[0]?.nodePort).toBe(service.spec?.ports?.[0]?.nodePort);
	});

	it("should read and list services", async () => {
		await createService({
			metadata: {
				name: "read-list-service",
				labels: { app: "read-list" },
			},
			spec: {
				type: "ClusterIP",
				ports: [{ port: 80 }],
			},
		});

		const read = await api.readNamespacedService({
			name: "read-list-service",
			namespace,
		});
		expect(read.metadata?.name).toBe("read-list-service");

		const namespaced = await api.listNamespacedService({
			namespace,
			labelSelector: "app=read-list",
		});
		expect(namespaced.items.map((service) => service.metadata?.name)).toContain(
			"read-list-service",
		);

		const all = await api.listServiceForAllNamespaces({
			labelSelector: "app=read-list",
		});
		expect(
			all.items.find(
				(service) =>
					service.metadata?.name === "read-list-service" &&
					service.metadata?.namespace === namespace,
			),
		).toBeTruthy();
	});

	it("should delete services", async () => {
		const service = await createService({
			metadata: {
				name: "delete-service",
			},
			spec: {
				type: "ClusterIP",
				ports: [{ port: 80 }],
			},
		});

		const deleted = await api.deleteNamespacedService({
			name: "delete-service",
			namespace,
		});

		expect(deleted.metadata?.name).toBe(service.metadata?.name);
		await expect(
			api.readNamespacedService({
				name: "delete-service",
				namespace,
			}),
		).rejects.toThrow(/NotFound|not found/);
	});

	it("should release ClusterIP and NodePort allocations on delete", async () => {
		const first = await createService({
			metadata: {
				name: "release-allocations-first",
			},
			spec: {
				type: "NodePort",
				ports: [{ port: 80 }],
			},
		});
		const clusterIP = first.spec?.clusterIP;
		const nodePort = first.spec?.ports?.[0]?.nodePort;
		if (!clusterIP || nodePort === undefined) {
			throw new Error("Expected Service allocations");
		}

		await api.deleteNamespacedService({
			name: "release-allocations-first",
			namespace,
		});

		const second = await createService({
			metadata: {
				name: "release-allocations-second",
			},
			spec: {
				type: "NodePort",
				clusterIP,
				ports: [{ port: 80, nodePort }],
			},
		});

		expect(second.spec?.clusterIP).toBe(clusterIP);
		expect(second.spec?.ports?.[0]?.nodePort).toBe(nodePort);
	});

	it("should load balance NodePort traffic across selected pods", async () => {
		const firstText = "echo-one";
		const secondText = "echo-two";
		await createEchoPod("http-echo-one", firstText);
		await createEchoPod("http-echo-two", secondText);

		const service = await createService({
			metadata: {
				name: "http-echo-lb",
			},
			spec: {
				type: "NodePort",
				selector: { app: "http-echo-lb" },
				ports: [{ name: "http", port: 80, targetPort: "http" }],
			},
		});
		const nodePort = service.spec?.ports?.[0]?.nodePort;
		if (nodePort === undefined) {
			throw new Error("Expected Service to allocate a NodePort");
		}

		await vi.waitFor(
			async () => {
				expectPodReady(await api.readNamespacedPod({ name: "http-echo-one", namespace }));
				expectPodReady(await api.readNamespacedPod({ name: "http-echo-two", namespace }));
			},
			{ timeout: 10_000, interval: 500 },
		);

		const bodies = new Set<string>();
		await vi.waitFor(
			async () => {
				for (let attempt = 0; attempt < 2; attempt++) {
					const response = await sendNodePortRequest(nodePort, { path: "/" });
					expect(response.status).toBe(200);
					if (response.body) {
						bodies.add(response.body.trim());
					}
				}
				expect(bodies).toEqual(new Set([firstText, secondText]));
			},
			{ timeout: 20_000, interval: 500 },
		);
	});
});

function expectPodReady(pod: V1Pod): void {
	expect(pod.spec?.nodeName).toBeTruthy();
	expect(pod.status?.phase).toBe("Running");
	expect(pod.status?.podIP).toBeTruthy();
	expect(pod.status?.containerStatuses?.[0]?.ready).toBe(true);
}
