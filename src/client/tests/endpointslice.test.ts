import { expect, it } from "vitest";
import type { V1Endpoint, V1EndpointSlice, V1Pod } from "../gen/models";
import { kubernetes } from "../../test/harnesses/kubernetes";

const READY_IMAGE = "crccheck/hello-world:latest";

kubernetes.describe("EndpointSlices", ({ core, discovery, helpers }) => {
	const {
		createAgnhostPod,
		createNodePortFor,
		fetchNodePort,
		getSuiteNamespace,
		waitFor,
		waitForPodReady,
	} = helpers;
	function endpointSlice(
		namespace: string,
		overrides: Partial<V1EndpointSlice> = {},
	): V1EndpointSlice {
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
		const namespace = await getSuiteNamespace();
		const slices = await discovery.listNamespacedEndpointSlice({
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
		const namespace = await getSuiteNamespace();
		const slices = await discovery.listNamespacedEndpointSlice({
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
		await core.createNamespacedPod({
			namespace: await getSuiteNamespace(),
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
		const pod = await core.readNamespacedPod({ name, namespace: await getSuiteNamespace() });
		const ip = pod.status?.podIP;
		if (!ip) {
			throw new Error(`Expected pod ${name} to have an IP address`);
		}
		return ip;
	}

	async function markPodNotReady(name: string): Promise<V1Pod> {
		const namespace = await getSuiteNamespace();
		const pod = await core.readNamespacedPod({ name, namespace });
		return await core.replaceNamespacedPodStatus({
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

	it("should create, read, list, replace, and delete endpoint slices", async () => {
		const namespace = await getSuiteNamespace();
		const created = await discovery.createNamespacedEndpointSlice({
			namespace,
			body: endpointSlice(namespace),
		});

		expect(created.metadata?.name).toBe("manual");
		expect(created.apiVersion).toBe("discovery.k8s.io/v1");
		expect(created.kind).toBe("EndpointSlice");
		expect(created.metadata?.namespace).toBe(namespace);
		expect(created.addressType).toBe("IPv4");
		expect(created.endpoints[0]?.addresses).toEqual(["10.0.0.10"]);
		expect(created.ports?.[0]).toMatchObject({
			name: "http",
			port: 8080,
			protocol: "TCP",
		});

		const read = await discovery.readNamespacedEndpointSlice({
			name: "manual",
			namespace,
		});
		expect(read.metadata?.name).toBe("manual");

		const namespaced = await discovery.listNamespacedEndpointSlice({
			namespace,
			labelSelector: `testNamespace=${namespace}`,
		});
		expect(namespaced.items.map((slice) => slice.metadata?.name)).toContain("manual");

		const all = await discovery.listEndpointSliceForAllNamespaces({
			labelSelector: `testNamespace=${namespace}`,
		});
		expect(
			all.items.find(
				(slice) => slice.metadata?.name === "manual" && slice.metadata?.namespace === namespace,
			),
		).toBeTruthy();

		const replaced = await discovery.replaceNamespacedEndpointSlice({
			name: "manual",
			namespace,
			body: {
				...read,
				endpoints: [{ addresses: ["10.0.0.11"], conditions: { ready: true } }],
			},
		});
		expect(replaced.endpoints[0]?.addresses).toEqual(["10.0.0.11"]);

		const deleted = await discovery.deleteNamespacedEndpointSlice({
			name: "manual",
			namespace,
		});
		expect(deleted.status).toBe("Success");

		await expect(
			discovery.readNamespacedEndpointSlice({
				name: "manual",
				namespace,
			}),
		).rejects.toThrow(/NotFound|not found/);
	});

	it("should create and update endpoint slices for services with selectors", async () => {
		const serviceName = "selected-service";
		const podName = "selected-pod";
		const app = "endpoint-slice-selected";

		await core.createNamespacedService({
			namespace: await getSuiteNamespace(),
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

		await waitFor(async () => {
			const slice = await serviceEndpointSlice(serviceName);
			expect(slice).toBeTruthy();
			expect(slice?.ports ?? []).toEqual([]);
			expect(slice?.endpoints ?? []).toEqual([]);
		});

		await createSelectedPod(podName, app, READY_IMAGE);

		await waitFor(async () => {
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
		});
	});

	it("should update endpoint slices when selected pods are added and removed", async () => {
		const serviceName = "multi-pod-service";
		const app = "endpoint-slice-multi";
		const firstPod = "multi-pod-one";
		const secondPod = "multi-pod-two";

		await core.createNamespacedService({
			namespace: await getSuiteNamespace(),
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
		await waitFor(async () => {
			firstIp = await podIp(firstPod);
			secondIp = await podIp(secondPod);

			const addresses = endpointAddresses(await serviceEndpointSlice(serviceName));
			expect(addresses).toEqual(expect.arrayContaining([firstIp, secondIp]));
		});

		await core.deleteNamespacedPod({
			name: firstPod,
			namespace: await getSuiteNamespace(),
			gracePeriodSeconds: 0,
			body: {
				gracePeriodSeconds: 0,
			},
		});

		await waitFor(async () => {
			const addresses = endpointAddresses(await serviceEndpointSlice(serviceName));
			expect(addresses).toContain(secondIp);
			expect(addresses).not.toContain(firstIp);
		});
	});

	it("should mark endpoints not ready when selected pods become not ready", async () => {
		const serviceName = "not-ready-service";
		const app = "endpoint-slice-not-ready";
		const podName = "not-ready-pod";

		await core.createNamespacedService({
			namespace: await getSuiteNamespace(),
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
		await waitFor(async () => {
			ip = await podIp(podName);
			const slice = await serviceEndpointSliceWithAddress(serviceName, ip);
			expect(readyEndpointAddresses(slice)).toContain(ip);
			expect(endpointForPod(slice, podName)?.conditions?.ready).not.toBe(false);
		});

		await waitFor(async () => {
			await markPodNotReady(podName);
			const slice = await serviceEndpointSliceWithAddress(serviceName, ip);
			const endpoint = endpointForPod(slice, podName);
			expect(endpoint?.addresses).toContain(ip);
			expect(endpoint?.conditions?.ready).toBe(false);
			expect(readyEndpointAddresses(slice)).not.toContain(ip);
		});
	});

	it("should copy service labels and set service owner references on generated slices", async () => {
		const namespace = await getSuiteNamespace();
		const serviceName = "metadata-service";
		const service = await core.createNamespacedService({
			namespace,
			body: {
				metadata: {
					name: serviceName,
					labels: {
						app: "endpoint-slice-metadata",
						tier: "backend",
					},
				},
				spec: {
					selector: { app: "endpoint-slice-metadata" },
					ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }],
				},
			},
		});

		await waitFor(async () => {
			const slice = await serviceEndpointSlice(serviceName);
			expect(slice?.metadata?.labels).toMatchObject({
				app: "endpoint-slice-metadata",
				tier: "backend",
				"kubernetes.io/service-name": serviceName,
				"endpointslice.kubernetes.io/managed-by": "endpointslice-controller.k8s.io",
			});
			expect(slice?.metadata?.ownerReferences).toContainEqual(
				expect.objectContaining({
					apiVersion: "v1",
					kind: "Service",
					name: serviceName,
					uid: service.metadata?.uid,
					controller: true,
				}),
			);
		});
	});

	it("should publish not-ready addresses as ready when services request it", async () => {
		const serviceName = "publish-not-ready-service";
		const app = "endpoint-slice-publish-not-ready";
		const podName = "publish-not-ready-pod";

		await core.createNamespacedService({
			namespace: await getSuiteNamespace(),
			body: {
				metadata: {
					name: serviceName,
				},
				spec: {
					publishNotReadyAddresses: true,
					selector: { app },
					ports: [{ name: "http", port: 80, targetPort: 8000, protocol: "TCP" }],
				},
			},
		});

		await createSelectedPod(podName, app, READY_IMAGE, 8000);

		let ip = "";
		await waitFor(async () => {
			ip = await podIp(podName);
			await markPodNotReady(podName);
			const endpoint = endpointForPod(
				await serviceEndpointSliceWithAddress(serviceName, ip),
				podName,
			);
			expect(endpoint?.addresses).toContain(ip);
			expect(endpoint?.conditions?.ready).toBe(true);
			expect(endpoint?.conditions?.serving).toBe(false);
			expect(endpoint?.conditions?.terminating).toBe(false);
		});
	});

	it("should mark terminal pod endpoints not ready", async () => {
		const serviceName = "terminal-pod-service";
		const app = "endpoint-slice-terminal";
		const podName = "terminal-pod";
		const namespace = await getSuiteNamespace();

		await core.createNamespacedService({
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

		let pod = await createAgnhostPod({
			metadata: {
				name: podName,
				namespace,
				labels: { app },
			},
			spec: {
				restartPolicy: "OnFailure",
			},
		});
		pod = await waitForPodReady(pod);
		const nodePort = await createNodePortFor([pod]);

		let ip = "";
		await waitFor(async () => {
			ip = await podIp(podName);
			expect(endpointAddresses(await serviceEndpointSlice(serviceName))).toContain(ip);
		});

		await fetchNodePort(nodePort, {
			path: "/exit?code=0&timeout=1s",
		});

		await waitFor(async () => {
			const current = await core.readNamespacedPod({ name: podName, namespace });
			expect(current.status?.phase).toBe("Succeeded");
			const endpoint = endpointForPod(
				await serviceEndpointSliceWithAddress(serviceName, ip),
				podName,
			);
			expect(endpoint?.addresses).toContain(ip);
			expect(endpoint?.conditions?.ready).toBe(false);
			expect(endpoint?.conditions?.serving).toBe(false);
			expect(endpoint?.conditions?.terminating).toBe(false);
		});
	});

	it("should keep terminating pods with terminating endpoint conditions", async () => {
		const serviceName = "terminating-pod-service";
		const app = "endpoint-slice-terminating";
		const podName = "terminating-pod";
		const namespace = await getSuiteNamespace();

		await core.createNamespacedService({
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

		await createSelectedPod(podName, app, READY_IMAGE);

		let ip = "";
		await waitFor(async () => {
			ip = await podIp(podName);
			expect(
				endpointForPod(await serviceEndpointSliceWithAddress(serviceName, ip), podName),
			).toBeTruthy();
		});

		await core.deleteNamespacedPod({
			name: podName,
			namespace,
			gracePeriodSeconds: 30,
			body: {
				gracePeriodSeconds: 30,
			},
		});

		await waitFor(async () => {
			const pod = await core.readNamespacedPod({ name: podName, namespace });
			expect(pod.metadata?.deletionTimestamp).toBeDefined();
			const endpoint = endpointForPod(
				await serviceEndpointSliceWithAddress(serviceName, ip),
				podName,
			);
			expect(endpoint?.addresses).toContain(ip);
			expect(endpoint?.conditions?.ready).toBe(false);
			expect(endpoint?.conditions?.terminating).toBe(true);
		});
	});

	it("should include appProtocol and only resolve named ports with matching protocol", async () => {
		const namespace = await getSuiteNamespace();
		const serviceName = "port-protocol-service";
		const app = "endpoint-slice-port-protocol";
		const podName = "port-protocol-pod";

		await core.createNamespacedService({
			namespace,
			body: {
				metadata: {
					name: serviceName,
				},
				spec: {
					selector: { app },
					ports: [
						{
							name: "http",
							port: 80,
							targetPort: "http",
							protocol: "TCP",
							appProtocol: "kubernetes.io/h2c",
						},
						{
							name: "udp-miss",
							port: 81,
							targetPort: "http",
							protocol: "UDP",
						},
					],
				},
			},
		});
		await core.createNamespacedPod({
			namespace,
			body: {
				metadata: {
					name: podName,
					labels: { app },
				},
				spec: {
					containers: [
						{
							name: podName,
							image: READY_IMAGE,
							ports: [{ name: "http", containerPort: 8080, protocol: "TCP" }],
						},
					],
				},
			},
		});

		await waitFor(async () => {
			const ip = await podIp(podName);
			const slice = await serviceEndpointSliceWithAddress(serviceName, ip);
			expect(slice?.ports).toEqual([
				{
					name: "http",
					port: 8080,
					protocol: "TCP",
					appProtocol: "kubernetes.io/h2c",
				},
			]);
		});
	});
});
