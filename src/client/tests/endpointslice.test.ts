import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { V1Endpoint, V1EndpointSlice, V1Pod } from "../gen/models";
import { kubernetes } from "../../test/harnesses/kubernetes";

const READY_IMAGE = "crccheck/hello-world:latest";

kubernetes.describe("EndpointSlices", ({ k8s, kubeConfig }) => {
	let coreApi: InstanceType<typeof k8s.CoreV1Api>;
	let discoveryApi: InstanceType<typeof k8s.DiscoveryV1Api>;
	let namespace: string;

	async function createNamespace(generateName: string): Promise<string> {
		const resp = await coreApi.createNamespace({
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

	function endpointSlice(overrides: Partial<V1EndpointSlice> = {}): V1EndpointSlice {
		return {
			apiVersion: "discovery.k8s.io/v1",
			kind: "EndpointSlice",
			addressType: "IPv4",
			endpoints: [
				{
					addresses: ["10.0.0.10"],
					conditions: {
						ready: true,
						serving: true,
						terminating: false,
					},
				},
			],
			ports: [{ name: "http", port: 8080, protocol: "TCP" }],
			...overrides,
			metadata: {
				name: "manual",
				labels: {
					"kubernetes.io/service-name": "manual",
					app: "endpoint-slice-test",
					testNamespace: namespace,
				},
				...overrides.metadata,
			},
		};
	}

	async function serviceEndpointSlice(serviceName: string): Promise<V1EndpointSlice | undefined> {
		const slices = await discoveryApi.listNamespacedEndpointSlice({
			namespace,
			labelSelector: `kubernetes.io/service-name=${serviceName}`,
		});
		return slices.items.find(
			(slice) => slice.metadata?.labels?.["kubernetes.io/service-name"] === serviceName,
		);
	}

	function endpointAddresses(slice: V1EndpointSlice | undefined): string[] {
		return (slice?.endpoints ?? []).flatMap((endpoint) => endpoint.addresses);
	}

	async function serviceEndpointSliceWithAddress(
		serviceName: string,
		address: string,
	): Promise<V1EndpointSlice | undefined> {
		const slices = await discoveryApi.listNamespacedEndpointSlice({
			namespace,
			labelSelector: `kubernetes.io/service-name=${serviceName}`,
		});
		return slices.items.find((slice) => endpointAddresses(slice).includes(address));
	}

	function readyEndpointAddresses(slice: V1EndpointSlice | undefined): string[] {
		return (slice?.endpoints ?? [])
			.filter((endpoint) => endpoint.conditions?.ready !== false)
			.flatMap((endpoint) => endpoint.addresses);
	}

	function endpointForPod(
		slice: V1EndpointSlice | undefined,
		podName: string,
	): V1Endpoint | undefined {
		return (slice?.endpoints ?? []).find((endpoint) => endpoint.targetRef?.name === podName);
	}

	async function createSelectedPod(
		name: string,
		app: string,
		image = "registry.k8s.io/pause:3.10",
		containerPort = 8080,
	): Promise<void> {
		await coreApi.createNamespacedPod({
			namespace,
			body: {
				metadata: {
					name,
					labels: { app },
				},
				spec: {
					containers: [
						{
							name,
							image,
							ports: [{ name: "http", containerPort }],
						},
					],
				},
			},
		});
	}

	async function podIp(name: string): Promise<string> {
		const pod = await coreApi.readNamespacedPod({ name, namespace });
		const ip = pod.status?.podIP;
		if (!ip) {
			throw new Error(`Expected pod ${name} to have an IP address`);
		}
		return ip;
	}

	async function markPodNotReady(name: string): Promise<V1Pod> {
		const pod = await coreApi.readNamespacedPod({ name, namespace });
		return await coreApi.replaceNamespacedPodStatus({
			name,
			namespace,
			body: {
				...pod,
				status: {
					...pod.status,
					conditions: (pod.status?.conditions ?? []).map((condition) =>
						condition.type === "Ready" || condition.type === "ContainersReady"
							? { ...condition, status: "False" }
							: condition,
					),
					containerStatuses: (pod.status?.containerStatuses ?? []).map((status) => ({
						...status,
						ready: false,
					})),
				},
			},
		});
	}

	beforeAll(async () => {
		coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
		discoveryApi = kubeConfig.makeApiClient(k8s.DiscoveryV1Api);
		namespace = await createNamespace("endpointslice-test-");
	});

	afterAll(async () => {
		await coreApi.deleteNamespace({
			name: namespace,
		});
	});

	it("should create, read, list, replace, and delete endpoint slices", async () => {
		const created = await discoveryApi.createNamespacedEndpointSlice({
			namespace,
			body: endpointSlice(),
		});

		expect(created.metadata?.name).toBe("manual");
		expect(created.metadata?.namespace).toBe(namespace);
		expect(created.addressType).toBe("IPv4");
		expect(created.endpoints[0]?.addresses).toEqual(["10.0.0.10"]);
		expect(created.ports?.[0]).toMatchObject({
			name: "http",
			port: 8080,
			protocol: "TCP",
		});

		const read = await discoveryApi.readNamespacedEndpointSlice({
			name: "manual",
			namespace,
		});
		expect(read.metadata?.name).toBe("manual");

		const namespaced = await discoveryApi.listNamespacedEndpointSlice({
			namespace,
			labelSelector: `testNamespace=${namespace}`,
		});
		expect(namespaced.items.map((slice) => slice.metadata?.name)).toContain("manual");

		const all = await discoveryApi.listEndpointSliceForAllNamespaces({
			labelSelector: `testNamespace=${namespace}`,
		});
		expect(
			all.items.find(
				(slice) => slice.metadata?.name === "manual" && slice.metadata?.namespace === namespace,
			),
		).toBeTruthy();

		const replaced = await discoveryApi.replaceNamespacedEndpointSlice({
			name: "manual",
			namespace,
			body: {
				...read,
				endpoints: [{ addresses: ["10.0.0.11"], conditions: { ready: true } }],
			},
		});
		expect(replaced.endpoints[0]?.addresses).toEqual(["10.0.0.11"]);

		const deleted = await discoveryApi.deleteNamespacedEndpointSlice({
			name: "manual",
			namespace,
		});
		expect(deleted.status).toBe("Success");

		await expect(
			discoveryApi.readNamespacedEndpointSlice({
				name: "manual",
				namespace,
			}),
		).rejects.toThrow(/NotFound|not found/);
	});

	it("should create and update endpoint slices for services with selectors", async () => {
		const serviceName = "selected-service";
		const podName = "selected-pod";
		const app = "endpoint-slice-selected";

		await coreApi.createNamespacedService({
			namespace,
			body: {
				metadata: {
					name: serviceName,
				},
				spec: {
					selector: { app },
					ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }],
				},
			},
		});

		await vi.waitFor(
			async () => {
				const slice = await serviceEndpointSlice(serviceName);
				expect(slice).toBeTruthy();
				expect(slice?.ports ?? []).toEqual([]);
				expect(slice?.endpoints ?? []).toEqual([]);
			},
			{ timeout: 10000, interval: 500 },
		);

		await createSelectedPod(podName, app, READY_IMAGE);

		await vi.waitFor(
			async () => {
				const ip = await podIp(podName);
				const slice = await serviceEndpointSlice(serviceName);
				expect(slice?.ports?.[0]).toMatchObject({
					name: "http",
					port: 8080,
					protocol: "TCP",
				});
				expect((slice?.endpoints ?? []).some((endpoint) => endpoint.addresses.includes(ip))).toBe(
					true,
				);
			},
			{ timeout: 10000, interval: 500 },
		);
	}, 30000);

	it("should update endpoint slices when selected pods are added and removed", async () => {
		const serviceName = "multi-pod-service";
		const app = "endpoint-slice-multi";
		const firstPod = "multi-pod-one";
		const secondPod = "multi-pod-two";

		await coreApi.createNamespacedService({
			namespace,
			body: {
				metadata: {
					name: serviceName,
				},
				spec: {
					selector: { app },
					ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }],
				},
			},
		});

		await createSelectedPod(firstPod, app);
		await createSelectedPod(secondPod, app);

		let firstIp = "";
		let secondIp = "";
		await vi.waitFor(
			async () => {
				firstIp = await podIp(firstPod);
				secondIp = await podIp(secondPod);

				const addresses = endpointAddresses(await serviceEndpointSlice(serviceName));
				expect(addresses).toEqual(expect.arrayContaining([firstIp, secondIp]));
			},
			{ timeout: 10000, interval: 500 },
		);

		await coreApi.deleteNamespacedPod({
			name: firstPod,
			namespace,
			gracePeriodSeconds: 0,
			body: {
				gracePeriodSeconds: 0,
			},
		});

		await vi.waitFor(
			async () => {
				const addresses = endpointAddresses(await serviceEndpointSlice(serviceName));
				expect(addresses).toContain(secondIp);
				expect(addresses).not.toContain(firstIp);
			},
			{ timeout: 10000, interval: 500 },
		);
	}, 10000);

	it("should mark endpoints not ready when selected pods become not ready", async () => {
		const serviceName = "not-ready-service";
		const app = "endpoint-slice-not-ready";
		const podName = "not-ready-pod";

		await coreApi.createNamespacedService({
			namespace,
			body: {
				metadata: {
					name: serviceName,
				},
				spec: {
					selector: { app },
					ports: [{ name: "http", port: 80, targetPort: 8000, protocol: "TCP" }],
				},
			},
		});

		await createSelectedPod(podName, app, READY_IMAGE, 8000);

		let ip = "";
		await vi.waitFor(
			async () => {
				ip = await podIp(podName);
				const slice = await serviceEndpointSliceWithAddress(serviceName, ip);
				expect(readyEndpointAddresses(slice)).toContain(ip);
				expect(endpointForPod(slice, podName)?.conditions?.ready).not.toBe(false);
			},
			{ timeout: 10000, interval: 500 },
		);

		await markPodNotReady(podName);

		await vi.waitFor(
			async () => {
				const slice = await serviceEndpointSliceWithAddress(serviceName, ip);
				const endpoint = endpointForPod(slice, podName);
				expect(endpoint?.addresses).toContain(ip);
				expect(endpoint?.conditions?.ready).toBe(false);
				expect(readyEndpointAddresses(slice)).not.toContain(ip);
			},
			{ timeout: 10000, interval: 500 },
		);
	}, 30000);
});
