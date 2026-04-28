import { beforeEach, describe, expect, it } from "vitest";

import { Clock } from "../../clock";
import type { KubeConfig } from "../../client/types";
import { NetworkError } from "../cni/error";
import type { ServiceInstance } from "../cni/service";
import { type ContainerConfig, type PodSandboxConfig, Runtime } from "./runtime";
import { ClusterNetwork } from "../cni";
import { ImageRegistry } from "./image";

const kubeConfig: KubeConfig = {
	makeApiClient() {
		throw new Error("test kubeConfig does not create API clients");
	},
};

describe("Runtime", () => {
	let clock: Clock;
	let network: ClusterNetwork;
	let imageRegistry: ImageRegistry;

	beforeEach(() => {
		clock = new Clock();
		network = new ClusterNetwork({
			podCIDR: "10.0.0.0/24",
		});
		imageRegistry = new ImageRegistry();
	});

	function sandboxConfig(
		overrides: Partial<PodSandboxConfig["metadata"]> & {
			labels?: Record<string, string>;
		} = {},
	): PodSandboxConfig {
		return {
			metadata: {
				uid: overrides.uid ?? "pod-1",
				name: overrides.name ?? "server",
				namespace: overrides.namespace ?? "default",
				attempt: overrides.attempt ?? 0,
			},
			labels: overrides.labels,
		};
	}

	function containerConfig(
		image: string,
		overrides: Partial<ContainerConfig> & {
			name?: string;
			attempt?: number;
		} = {},
	): ContainerConfig {
		return {
			metadata: {
				name: overrides.name ?? "server",
				attempt: overrides.attempt ?? 0,
			},
			image: { image },
			ports: overrides.ports,
			command: overrides.command,
			args: overrides.args,
			env: overrides.env,
			stopSignal: overrides.stopSignal,
		};
	}

	it("starts an image process that listens and fetches by pod IP", async () => {
		const runtime = new Runtime({ clock, kubeConfig, network, imageRegistry });
		runtime.imageRegistry.register("test/http", {
			async start(context) {
				context.listenHttp(8080, async (request) => ({
					status: 200,
					body: `pod=${context.pod.name} path=${request.path}`,
				}));
				return await context.waitUntilKilled();
			},
			async exec() {
				return 0;
			},
		});

		const podConfig = sandboxConfig();
		const podSandboxId = await runtime.runPodSandbox(podConfig);
		const pod = runtime.getPodSandbox(podSandboxId);
		if (!pod) {
			throw new Error("expected sandbox");
		}
		const containerId = await runtime.createContainer(
			podSandboxId,
			containerConfig("test/http"),
			podConfig,
		);
		await runtime.startContainer(containerId);

		const response = await runtime.network.fetch(
			pod.networkPeer(),
			`http://${pod.ip}:8080/healthz?ready=1`,
		);

		expect(response).toEqual({
			status: 200,
			body: "pod=server path=/healthz?ready=1",
		});
	});

	it("closes process-owned HTTP listeners when a container stops", async () => {
		const runtime = new Runtime({ clock, kubeConfig, network, imageRegistry });
		runtime.imageRegistry.register("test/http", {
			async start(context) {
				context.listenHttp(8080, async () => ({ status: 204 }));
				return await context.waitUntilKilled();
			},
			async exec() {
				return 0;
			},
		});
		const podConfig = sandboxConfig();
		const podSandboxId = await runtime.runPodSandbox(podConfig);
		const pod = runtime.getPodSandbox(podSandboxId);
		if (!pod) {
			throw new Error("expected sandbox");
		}
		const containerId = await runtime.createContainer(
			podSandboxId,
			containerConfig("test/http"),
			podConfig,
		);
		await runtime.startContainer(containerId);

		await runtime.stopContainer(containerId, 30);

		await expect(
			runtime.network.fetch(pod.networkPeer(), `http://${pod.ip}:8080/`),
		).rejects.toBeInstanceOf(NetworkError);
	});

	it("routes NodePort service traffic to a ready matching pod", async () => {
		const runtime = new Runtime({ clock, kubeConfig, network, imageRegistry });
		runtime.imageRegistry.register("test/http", {
			async start(context) {
				context.listenHttp(8080, async () => ({
					status: 200,
					headers: { server: "fake-image" },
					body: context.pod.ip,
				}));
				return await context.waitUntilKilled();
			},
			async exec() {
				return 0;
			},
		});
		const podConfig = sandboxConfig({ labels: { app: "demo" } });
		const podSandboxId = await runtime.runPodSandbox(podConfig);
		const pod = runtime.getPodSandbox(podSandboxId);
		if (!pod) {
			throw new Error("expected sandbox");
		}
		const containerId = await runtime.createContainer(
			podSandboxId,
			containerConfig("test/http", {
				ports: [{ name: "http", containerPort: 8080 }],
			}),
			podConfig,
		);
		await runtime.startContainer(containerId);
		const service: ServiceInstance = {
			uid: "service-1",
			name: "demo",
			namespace: "default",
			clusterIp: "10.96.0.10",
			type: "NodePort",
			selector: new Map([["app", "demo"]]),
			ports: [{ port: 80, targetPort: "http", nodePort: 30080 }],
		};
		runtime.network.registerService(service);

		const response = await runtime.network.fetchNodePort(30080);
		const clusterIpResponse = await runtime.network.fetch(pod.networkPeer(), "http://demo/");
		const namespacedResponse = await runtime.network.fetch(
			pod.networkPeer(),
			"http://demo.default/",
		);
		const svcResponse = await runtime.network.fetch(pod.networkPeer(), "http://demo.default.svc/");
		const fqdnResponse = await runtime.network.fetch(
			pod.networkPeer(),
			"http://demo.default.svc.cluster.local/",
		);

		expect(response).toEqual({
			status: 200,
			headers: { server: "fake-image" },
			body: pod.ip,
		});
		expect(clusterIpResponse.body).toBe(pod.ip);
		expect(namespacedResponse.body).toBe(pod.ip);
		expect(svcResponse.body).toBe(pod.ip);
		expect(fqdnResponse.body).toBe(pod.ip);
	});

	it("removes NodePort routes when a service is unregistered", async () => {
		const runtime = new Runtime({ clock, kubeConfig, network, imageRegistry });
		const service: ServiceInstance = {
			uid: "service-1",
			name: "demo",
			namespace: "default",
			clusterIp: "10.96.0.10",
			type: "NodePort",
			selector: new Map([["app", "demo"]]),
			ports: [{ port: 80, targetPort: 8080, nodePort: 30080 }],
		};
		runtime.network.registerService(service);

		runtime.network.unregisterService("default", "demo");

		await expect(runtime.network.fetchNodePort(30080)).rejects.toThrow(
			"no Service for NodePort 30080",
		);
	});

	it("updates service endpoints when pod readiness changes", async () => {
		const runtime = new Runtime({ clock, kubeConfig, network, imageRegistry });
		runtime.imageRegistry.register("test/http", {
			async start(context) {
				context.listenHttp(8080, async () => ({ status: 204 }));
				return await context.waitUntilKilled();
			},
			async exec() {
				return 0;
			},
		});
		const service: ServiceInstance = {
			uid: "service-1",
			name: "demo",
			namespace: "default",
			clusterIp: "10.96.0.10",
			type: "ClusterIP",
			selector: new Map([["app", "demo"]]),
			ports: [{ port: 80, targetPort: 8080 }],
		};
		runtime.network.registerService(service);
		const podConfig = sandboxConfig({ labels: { app: "demo" } });
		const podSandboxId = await runtime.runPodSandbox(podConfig);
		const pod = runtime.getPodSandbox(podSandboxId);
		if (!pod) {
			throw new Error("expected sandbox");
		}
		const containerId = await runtime.createContainer(
			podSandboxId,
			containerConfig("test/http"),
			podConfig,
		);

		await expect(runtime.network.fetch(pod.networkPeer(), "http://10.96.0.10/")).rejects.toThrow(
			"Service default/demo has no ready endpoints",
		);

		await runtime.startContainer(containerId);
		await expect(runtime.network.fetch(pod.networkPeer(), "http://10.96.0.10/")).resolves.toEqual({
			status: 204,
		});

		await runtime.stopContainer(containerId);
		await expect(runtime.network.fetch(pod.networkPeer(), "http://10.96.0.10/")).rejects.toThrow(
			"Service default/demo has no ready endpoints",
		);
	});

	it("allows multiple sandbox attempts for the same pod uid", async () => {
		const runtime = new Runtime({ clock, kubeConfig, network, imageRegistry });
		const firstConfig = sandboxConfig({ attempt: 0 });
		const secondConfig = sandboxConfig({ attempt: 1 });

		const firstSandboxId = await runtime.runPodSandbox(firstConfig);
		const secondSandboxId = await runtime.runPodSandbox(secondConfig);

		expect(firstSandboxId).not.toBe(secondSandboxId);
		expect(runtime.getPodSandboxesByPodUid("pod-1").map((sandbox) => sandbox.id)).toEqual([
			secondSandboxId,
			firstSandboxId,
		]);
		expect(runtime.podSandboxStatus(secondSandboxId)).toMatchObject({
			id: secondSandboxId,
			metadata: { uid: "pod-1", attempt: 1 },
			state: "Ready",
			network: { ip: expect.any(String) },
		});
	});

	it("reports sandbox IP through status only while sandbox networking is set up", async () => {
		const runtime = new Runtime({ clock, kubeConfig, network, imageRegistry });
		const podSandboxId = await runtime.runPodSandbox(sandboxConfig());

		expect(runtime.podSandboxStatus(podSandboxId)).toMatchObject({
			state: "Ready",
			network: { ip: "10.0.0.1" },
		});

		await runtime.stopPodSandbox(podSandboxId);

		expect(runtime.podSandboxStatus(podSandboxId)).toMatchObject({
			state: "NotReady",
		});
		expect(runtime.podSandboxStatus(podSandboxId).network).toBeUndefined();
	});

	it("resolves DNS through the configured DNS server IP", async () => {
		const runtime = new Runtime({ clock, kubeConfig, network, imageRegistry });
		runtime.imageRegistry.register("test/dns", {
			async start(context) {
				context.listenDns(53, async (request) => ({
					rcode: "NOERROR",
					answers: [{ type: "A", name: request.name, address: "10.96.0.10", ttl: 30 }],
				}));
				return await context.waitUntilKilled();
			},
			async exec() {
				return 0;
			},
		});
		let dnsResponseBody = "";
		runtime.imageRegistry.register("test/client", {
			async start(context) {
				const response = await context.resolveDns("demo.default.svc.cluster.local");
				dnsResponseBody = response.answers[0]?.type === "A" ? response.answers[0].address : "";
				return response.answers[0]?.type === "A" ? 0 : 1;
			},
			async exec() {
				return 0;
			},
		});

		const dnsPodConfig = sandboxConfig({ name: "dns", uid: "dns-pod" });
		const dnsSandboxId = await runtime.runPodSandbox(dnsPodConfig);
		const dnsPod = runtime.getPodSandbox(dnsSandboxId);
		if (!dnsPod) {
			throw new Error("expected DNS sandbox");
		}
		const dnsContainerId = await runtime.createContainer(
			dnsSandboxId,
			containerConfig("test/dns", { name: "dns" }),
			dnsPodConfig,
		);
		await runtime.startContainer(dnsContainerId);

		const clientPodConfig = {
			...sandboxConfig({ name: "client", uid: "client-pod" }),
			dnsConfig: { servers: [dnsPod.ip], searches: [], options: [] },
		};
		const clientSandboxId = await runtime.runPodSandbox(clientPodConfig);
		const clientContainerId = await runtime.createContainer(
			clientSandboxId,
			containerConfig("test/client", { name: "client" }),
			clientPodConfig,
		);
		await runtime.startContainer(clientContainerId);
		await Promise.resolve();
		await Promise.resolve();

		expect(dnsResponseBody).toBe("10.96.0.10");
	});

	it("applies DNS search domains before resolving short service names", async () => {
		const runtime = new Runtime({ clock, kubeConfig, network, imageRegistry });
		const queries: string[] = [];
		runtime.imageRegistry.register("test/dns", {
			async start(context) {
				context.listenDns(53, async (request) => {
					queries.push(request.name);
					if (request.name !== "foo.bar.svc.cluster.local") {
						return { rcode: "NXDOMAIN", answers: [] };
					}
					return {
						rcode: "NOERROR",
						answers: [{ type: "A", name: request.name, address: "10.96.0.20", ttl: 30 }],
					};
				});
				return await context.waitUntilKilled();
			},
			async exec() {
				return 0;
			},
		});
		let resolvedAddress = "";
		runtime.imageRegistry.register("test/client", {
			async start(context) {
				const response = await context.resolveDns("foo");
				resolvedAddress = response.answers[0]?.type === "A" ? response.answers[0].address : "";
				return resolvedAddress ? 0 : 1;
			},
			async exec() {
				return 0;
			},
		});

		const dnsPodConfig = sandboxConfig({ name: "dns", uid: "dns-pod" });
		const dnsSandboxId = await runtime.runPodSandbox(dnsPodConfig);
		const dnsPod = runtime.getPodSandbox(dnsSandboxId);
		if (!dnsPod) {
			throw new Error("expected DNS sandbox");
		}
		const dnsContainerId = await runtime.createContainer(
			dnsSandboxId,
			containerConfig("test/dns", { name: "dns" }),
			dnsPodConfig,
		);
		await runtime.startContainer(dnsContainerId);

		const clientPodConfig = {
			...sandboxConfig({ name: "client", namespace: "bar", uid: "client-pod" }),
			dnsConfig: {
				servers: [dnsPod.ip],
				searches: ["bar.svc.cluster.local", "svc.cluster.local", "cluster.local"],
				options: ["ndots:5"],
			},
		};
		const clientSandboxId = await runtime.runPodSandbox(clientPodConfig);
		const clientContainerId = await runtime.createContainer(
			clientSandboxId,
			containerConfig("test/client", { name: "client" }),
			clientPodConfig,
		);
		await runtime.startContainer(clientContainerId);
		await Promise.resolve();
		await Promise.resolve();

		expect(queries[0]).toBe("foo.bar.svc.cluster.local");
		expect(resolvedAddress).toBe("10.96.0.20");
	});

	it("removes a sandbox idempotently after stopping its containers", async () => {
		const runtime = new Runtime({ clock, kubeConfig, network, imageRegistry });
		runtime.imageRegistry.register("test/http", {
			async start(context) {
				context.listenHttp(8080, async () => ({ status: 204 }));
				return await context.waitUntilKilled();
			},
			async exec() {
				return 0;
			},
		});
		const podConfig = sandboxConfig();
		const podSandboxId = await runtime.runPodSandbox(podConfig);
		const containerId = await runtime.createContainer(
			podSandboxId,
			containerConfig("test/http"),
			podConfig,
		);
		await runtime.startContainer(containerId);

		await runtime.removePodSandbox(podSandboxId);
		await runtime.removePodSandbox(podSandboxId);

		expect(runtime.getPodSandbox(podSandboxId)).toBeUndefined();
		expect(runtime.getContainer(containerId)).toBeUndefined();
	});

	it("aborts context sleep when the process is killed", async () => {
		const runtime = new Runtime({ clock, kubeConfig, network, imageRegistry });
		let sleepRejected = false;
		runtime.imageRegistry.register("test/sleep", {
			async start(context) {
				try {
					await context.sleep(60_000);
					return 0;
				} catch {
					sleepRejected = true;
					return context.exit(143);
				}
			},
			async exec() {
				return 0;
			},
		});
		const podConfig = sandboxConfig({ name: "sleeper" });
		const podSandboxId = await runtime.runPodSandbox(podConfig);
		const containerId = await runtime.createContainer(
			podSandboxId,
			containerConfig("test/sleep", { name: "sleeper" }),
			podConfig,
		);
		await runtime.startContainer(containerId);

		await runtime.stopContainer(containerId, 30);
		await Promise.resolve();

		expect(runtime.containerStatus(containerId).exitCode).toBe(143);
		expect(sleepRejected).toBe(true);
	});
});
