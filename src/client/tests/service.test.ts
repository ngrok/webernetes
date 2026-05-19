import { expect, it } from "vitest";
import type { V1Pod, V1Service } from "../gen/models";
import { kubernetes } from "../../test/harnesses/kubernetes";
import { apiStatusMessage } from "../../test/harnesses/helpers";

kubernetes.describe("Services", ({ core, k8s, helpers, target }) => {
	const { getSuiteNamespace, fetchNodePort, waitFor } = helpers;
	const mergePatchOptions = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);

	async function createService(service: Partial<V1Service>): Promise<V1Service> {
		const namespace = await getSuiteNamespace();
		return await core.createNamespacedService({
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
		await core.createNamespacedPod({
			namespace: await getSuiteNamespace(),
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
		expect(service.apiVersion).toBe("v1");
		expect(service.kind).toBe("Service");
		expect(service.metadata?.namespace).toBe(await getSuiteNamespace());
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

		const namespace = await getSuiteNamespace();
		const replaced = await core.replaceNamespacedService({
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

	it("should be able to patch a service", async () => {
		const service = await createService({
			metadata: {
				name: "patch-service",
				labels: {
					app: "original",
					remove: "true",
				},
			},
			spec: {
				type: "ClusterIP",
				selector: { app: "original" },
				ports: [{ name: "http", port: 80 }],
			},
		});
		const namespace = await getSuiteNamespace();

		const patched = await core.patchNamespacedService(
			{
				name: "patch-service",
				namespace,
				body: {
					metadata: {
						labels: {
							app: "patched",
							remove: null,
						},
					},
					spec: {
						selector: { app: "patched" },
					},
				},
			},
			mergePatchOptions,
		);

		expect(patched.metadata?.labels?.app).toBe("patched");
		expect(patched.metadata?.labels?.remove).toBeUndefined();
		expect(patched.spec?.selector?.app).toBe("patched");
		expect(patched.spec?.clusterIP).toBe(service.spec?.clusterIP);
		expect(patched.spec?.ports?.[0]?.port).toBe(80);
	});

	it("should reject patching a service name", async () => {
		const name = "patch-name-service";
		const changedName = `${name}-changed`;
		await createService({
			metadata: {
				name,
			},
			spec: {
				type: "ClusterIP",
				ports: [{ port: 80 }],
			},
		});
		const namespace = await getSuiteNamespace();

		await expect(
			core.patchNamespacedService(
				{
					name,
					namespace,
					body: {
						metadata: {
							name: changedName,
						},
					},
				},
				mergePatchOptions,
			),
		).rejects.toThrow(
			`the name of the object (${changedName}) does not match the name on the URL (${name})`,
		);
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

		const namespace = await getSuiteNamespace();
		const read = await core.readNamespacedService({
			name: "read-list-service",
			namespace,
		});
		expect(read.metadata?.name).toBe("read-list-service");

		const namespaced = await core.listNamespacedService({
			namespace,
			labelSelector: "app=read-list",
		});
		expect(namespaced.items.map((service) => service.metadata?.name)).toContain(
			"read-list-service",
		);

		const all = await core.listServiceForAllNamespaces({
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

		const namespace = await getSuiteNamespace();
		const deleted = await core.deleteNamespacedService({
			name: "delete-service",
			namespace,
		});

		expect(deleted.metadata?.name).toBe(service.metadata?.name);
		await expect(
			core.readNamespacedService({
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

		await core.deleteNamespacedService({
			name: "release-allocations-first",
			namespace: await getSuiteNamespace(),
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

	it("should keep another Service's NodePort allocated after a failed create", async () => {
		const owner = await createService({
			metadata: {
				name: "failed-create-node-port-owner",
			},
			spec: {
				type: "NodePort",
				ports: [{ port: 80 }],
			},
		});
		const nodePort = owner.spec?.ports?.[0]?.nodePort;
		if (nodePort === undefined) {
			throw new Error("Expected Service to allocate a NodePort");
		}

		let failedCreateError: unknown;
		try {
			await createService({
				metadata: {
					name: "failed-create-node-port-contender",
				},
				spec: {
					type: "NodePort",
					ports: [{ port: 81, nodePort }],
				},
			});
		} catch (error) {
			failedCreateError = error;
		}
		expect(apiStatusMessage(failedCreateError)).toBe(
			nodePortAlreadyAllocatedMessage(target, "failed-create-node-port-contender", nodePort),
		);

		let stillAllocatedError: unknown;
		try {
			await createService({
				metadata: {
					name: "failed-create-node-port-reuse",
				},
				spec: {
					type: "NodePort",
					ports: [{ port: 82, nodePort }],
				},
			});
		} catch (error) {
			stillAllocatedError = error;
		}
		expect(apiStatusMessage(stillAllocatedError)).toBe(
			nodePortAlreadyAllocatedMessage(target, "failed-create-node-port-reuse", nodePort),
		);
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

		await waitFor(async () => {
			expectPodReady(
				await core.readNamespacedPod({
					name: "http-echo-one",
					namespace: await getSuiteNamespace(),
				}),
			);
			expectPodReady(
				await core.readNamespacedPod({
					name: "http-echo-two",
					namespace: await getSuiteNamespace(),
				}),
			);
		});

		const bodies = new Set<string>();
		await waitFor(async () => {
			for (let attempt = 0; attempt < 2; attempt++) {
				const response = await fetchNodePort(nodePort, { path: "/" });
				expect(response.status).toBe(200);
				if (response.body) {
					bodies.add(response.body.trim());
				}
			}
			expect(bodies).toEqual(new Set([firstText, secondText]));
		});
	});
});

function expectPodReady(pod: V1Pod): void {
	expect(pod.spec?.nodeName).toBeTruthy();
	expect(pod.status?.phase).toBe("Running");
	expect(pod.status?.podIP).toBeTruthy();
	expect(pod.status?.containerStatuses?.[0]?.ready).toBe(true);
}

function nodePortAlreadyAllocatedMessage(
	target: "k3s" | "simulator",
	serviceName: string,
	nodePort: number,
): string {
	if (target === "k3s") {
		return `Service "${serviceName}" is invalid: spec.ports[0].nodePort: Invalid value: ${nodePort}: provided port is already allocated`;
	}
	return `nodePort ${nodePort} is already allocated`;
}
