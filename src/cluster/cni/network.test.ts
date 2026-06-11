import { expect, it, vi } from "vitest";

import { Clock } from "../../clock";
import type { V1Node, V1Pod, V1Service } from "../../client";
import * as context from "../../go/context";
import { withLatencyProvider, newLatencyProvider } from "../../latency";
import { browser } from "../../test/describe";
import { waitFor } from "../../test/wait";
import { PodSandboxInstance } from "../cri/runtime";
import {
	ClusterNetwork,
	networkRequestIDHeader,
	type NetworkHop,
	type NetworkRequestEvent,
	type NetworkResponseEvent,
} from "./network";

browser.describe("ClusterNetwork", () => {
	it("normalizes fetch init into HTTP requests", async () => {
		const network = new ClusterNetwork();
		const pod = new PodSandboxInstance(
			"sandbox-1",
			{
				metadata: {
					name: "web",
					uid: "pod-uid",
					namespace: "default",
					attempt: 0,
				},
				pod: podOrigin("pod-uid"),
			},
			0,
		);
		const registration = network.setupPodSandbox(pod, "10.244.0.0/24");
		pod.setNetworkRegistration(registration);
		registration.bindHttp(8080, async (_ctx, request) => ({
			status: 200,
			body: JSON.stringify({
				method: request.method,
				url: request.url.toString(),
				header: request.header,
				host: request.host,
				body: request.body,
			}),
		}));

		const response = await network.fetch(
			context.background(),
			podOrigin("pod-uid"),
			`http://${registration.ip}:8080/echo`,
			{
				method: "POST",
				headers: {
					Host: "example.test",
					"X-Test": "yes",
				},
				body: "hello",
			},
		);
		expect(response.status).toBe(200);
		expect(JSON.parse(response.body)).toEqual({
			method: "POST",
			url: `http://${registration.ip}:8080/echo`,
			header: {
				Host: ["example.test"],
				"X-Test": ["yes"],
				"X-Webernetes-Request-Id": [expect.any(String)],
			},
			host: "example.test",
			body: "hello",
		});
	});

	it("resolves localhost to the origin pod IP", async () => {
		const network = new ClusterNetwork();
		const pod = new PodSandboxInstance(
			"sandbox-1",
			{
				metadata: {
					name: "web",
					uid: "pod-uid",
					namespace: "default",
					attempt: 0,
				},
				pod: podOrigin("pod-uid"),
			},
			0,
		);
		const registration = network.setupPodSandbox(pod, "10.244.0.0/24");
		pod.setNetworkRegistration(registration);
		registration.bindHttp(8080, async (_ctx, request) => ({
			status: 200,
			body: request.url.toString(),
		}));

		await expect(
			network.fetch(context.background(), podOrigin("pod-uid"), "http://localhost:8080/healthz"),
		).resolves.toEqual({
			status: 200,
			body: `http://${registration.ip}:8080/healthz`,
		});
	});

	it("resolves localhost to the origin node IP", async () => {
		const network = new ClusterNetwork();
		const pod = new PodSandboxInstance(
			"sandbox-1",
			{
				metadata: {
					name: "web",
					uid: "pod-uid",
					namespace: "default",
					attempt: 0,
				},
				pod: podOrigin("pod-uid"),
			},
			0,
		);
		const registration = network.setupPodSandbox(pod, "10.244.0.0/24");
		pod.setNetworkRegistration(registration);

		network.registerNode(nodeOrigin("node-1"));
		network.registerService(nodePortService());
		network.setServiceTargets("default", "web", 80, [`${registration.ip}:8080`]);
		registration.bindHttp(8080, async () => ({
			status: 200,
			body: "ok",
		}));

		await expect(
			network.fetch(context.background(), nodeOrigin("node-1"), "http://localhost:30080/"),
		).resolves.toEqual({
			status: 200,
			body: "ok",
		});
	});

	it("routes requests to registered node IPs through NodePort services", async () => {
		const network = new ClusterNetwork();
		const pod = new PodSandboxInstance(
			"sandbox-1",
			{
				metadata: {
					name: "web",
					uid: "pod-uid",
					namespace: "default",
					attempt: 0,
				},
				pod: podOrigin("pod-uid"),
			},
			0,
		);
		const registration = network.setupPodSandbox(pod, "10.244.0.0/24");
		pod.setNetworkRegistration(registration);

		network.registerNode(nodeOrigin("node-1"));
		network.registerService(nodePortService());
		network.setServiceTargets("default", "web", 80, [`${registration.ip}:8080`]);
		registration.bindHttp(8080, async (_ctx, request) => {
			return {
				status: 200,
				body: request.url.toString(),
			};
		});

		await expect(
			network.fetch(context.background(), nodeOrigin("node-1"), "http://192.168.1.1:30080/path"),
		).resolves.toEqual({
			status: 200,
			body: "http://192.168.1.1:30080/path",
		});
	});

	it("routes requests to registered node names through NodePort services", async () => {
		const network = new ClusterNetwork();
		const pod = new PodSandboxInstance(
			"sandbox-1",
			{
				metadata: {
					name: "web",
					uid: "pod-uid",
					namespace: "default",
					attempt: 0,
				},
				pod: podOrigin("pod-uid"),
			},
			0,
		);
		const registration = network.setupPodSandbox(pod, "10.244.0.0/24");
		pod.setNetworkRegistration(registration);

		network.registerNode(
			nodeOrigin("node-1", [
				{ type: "Hostname", address: "node-1" },
				{ type: "InternalDNS", address: "node-1.internal.test" },
			]),
		);
		network.registerService(nodePortService());
		network.setServiceTargets("default", "web", 80, [`${registration.ip}:8080`]);
		registration.bindHttp(8080, async (_ctx, request) => {
			return {
				status: 200,
				body: JSON.stringify({
					url: request.url.toString(),
					host: request.host,
				}),
			};
		});

		await expect(
			network.fetch(context.background(), nodeOrigin("node-1"), "http://node-1:30080/path"),
		).resolves.toEqual({
			status: 200,
			body: JSON.stringify({
				url: "http://192.168.1.1:30080/path",
				host: "node-1:30080",
			}),
		});

		await expect(
			network.fetch(
				context.background(),
				nodeOrigin("node-1"),
				"http://node-1.internal.test:30080/path",
			),
		).resolves.toEqual({
			status: 200,
			body: JSON.stringify({
				url: "http://192.168.1.1:30080/path",
				host: "node-1.internal.test:30080",
			}),
		});
	});

	it("stops routing node IP requests after the node is unregistered", async () => {
		const network = new ClusterNetwork();
		const pod = new PodSandboxInstance(
			"sandbox-1",
			{
				metadata: {
					name: "web",
					uid: "pod-uid",
					namespace: "default",
					attempt: 0,
				},
				pod: podOrigin("pod-uid"),
			},
			0,
		);
		const registration = network.setupPodSandbox(pod, "10.244.0.0/24");
		pod.setNetworkRegistration(registration);

		network.registerNode(nodeOrigin("node-1"));
		network.registerService(nodePortService());
		network.setServiceTargets("default", "web", 80, [`${registration.ip}:8080`]);
		registration.bindHttp(8080, async () => ({
			status: 200,
			body: "ok",
		}));

		await expect(
			network.fetch(context.background(), nodeOrigin("node-1"), "http://192.168.1.1:30080/"),
		).resolves.toEqual({
			status: 200,
			body: "ok",
		});

		network.unregisterNode("node-1");

		await expect(
			network.fetch(context.background(), nodeOrigin("node-1"), "http://192.168.1.1:30080/"),
		).rejects.toThrow("dial tcp 192.168.1.1:30080: connect: connection refused");
	});

	it("falls back to default fetch for public IP literals", async () => {
		const network = new ClusterNetwork();
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("external", {
				status: 200,
				headers: { "Content-Type": "text/plain" },
			}),
		);
		try {
			await expect(
				network.fetch(context.background(), nodeOrigin("node-1"), "https://93.184.216.34/"),
			).resolves.toEqual({
				status: 200,
				header: { "content-type": ["text/plain"] },
				body: "external",
			});
			expect(fetch).toHaveBeenCalledWith("https://93.184.216.34/", {
				method: undefined,
				headers: [],
				body: undefined,
				signal: expect.any(AbortSignal),
			});
		} finally {
			fetch.mockRestore();
		}
	});

	it("reports default fetch failures as network errors", async () => {
		const network = new ClusterNetwork();
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
		try {
			await expect(
				network.fetch(context.background(), nodeOrigin("node-1"), "https://93.184.216.34/"),
			).rejects.toThrow("Failed to fetch");
		} finally {
			fetch.mockRestore();
		}
	});

	it("keeps private and local IP literals on the simulated network", async () => {
		const network = new ClusterNetwork();
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("external"));
		try {
			await expect(
				network.fetch(context.background(), nodeOrigin("node-1"), "http://10.1.2.3:8080/"),
			).rejects.toThrow("dial tcp 10.1.2.3:8080: connect: connection refused");
			await expect(
				network.fetch(context.background(), nodeOrigin("node-1"), "http://[fd12:3456::1]:8080/"),
			).rejects.toThrow("dial tcp [fd12:3456::1]:8080: connect: connection refused");
			await expect(
				network.fetch(context.background(), nodeOrigin("node-1"), "http://[fe80::1]:8080/"),
			).rejects.toThrow("dial tcp [fe80::1]:8080: connect: connection refused");
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});

	it("routes service requests to registered pod endpoints even after the listener exits", async () => {
		const network = new ClusterNetwork();
		const pod = new PodSandboxInstance(
			"sandbox-1",
			{
				metadata: {
					name: "web",
					uid: "pod-uid",
					namespace: "default",
					attempt: 0,
				},
				pod: podOrigin("pod-uid"),
			},
			0,
		);
		const registration = network.setupPodSandbox(pod, "10.244.0.0/24");
		pod.setNetworkRegistration(registration);

		network.registerService(clusterIPService());
		network.setServiceTargets("default", "web", 80, [`${registration.ip}:8080`]);

		const listener = registration.bindHttp(8080, async () => ({
			status: 200,
			body: "ok",
		}));
		await expect(
			network.fetch(context.background(), podOrigin("pod-uid"), "http://10.96.0.10:80/"),
		).resolves.toEqual({
			status: 200,
			body: "ok",
		});

		listener.close();

		await expect(
			network.fetch(context.background(), podOrigin("pod-uid"), "http://10.96.0.10:80/"),
		).rejects.toThrow(`dial tcp ${registration.ip}:8080: connect: connection refused`);
	});

	it("emits request and response events with service endpoint chains", async () => {
		const network = new ClusterNetwork();
		const pod = new PodSandboxInstance(
			"sandbox-1",
			{
				metadata: {
					name: "web",
					uid: "pod-uid",
					namespace: "default",
					attempt: 0,
				},
				pod: podOrigin("pod-uid"),
			},
			0,
		);
		const registration = network.setupPodSandbox(pod, "10.244.0.0/24");
		pod.setNetworkRegistration(registration);
		network.registerService(clusterIPService());
		network.setServiceTargets("default", "web", 80, [`${registration.ip}:8080`]);
		let handlerRequestID = "";
		registration.bindHttp(8080, async (_ctx, request) => {
			handlerRequestID = request.header[networkRequestIDHeader]?.[0] ?? "";
			return {
				status: 201,
				header: { "X-App": ["ok"] },
				body: "created",
			};
		});

		const requests: NetworkRequestEvent[] = [];
		const responses: NetworkResponseEvent[] = [];
		network.on("request", (event) => requests.push(event));
		network.on("response", (event) => responses.push(event));

		await expect(
			network.fetch(context.background(), podOrigin("client-uid"), "http://10.96.0.10:80/"),
		).resolves.toMatchObject({
			status: 201,
			body: "created",
		});

		expect(requests).toHaveLength(1);
		expect(responses).toHaveLength(1);
		const request = requests[0] as NetworkRequestEvent;
		const response = responses[0] as NetworkResponseEvent;
		expect(request.error).toBeUndefined();
		expect(request.latencyMs).toBe(0);
		expect(response.latencyMs).toBe(0);
		expect(request.chain.map((hop) => hop.type)).toEqual(["pod", "service", "pod"]);
		expect(response.chain.map((hop) => hop.type)).toEqual(["pod", "service", "pod"]);
		expect(request.chain[0]).toMatchObject({
			type: "pod",
			pod: { metadata: { uid: "client-uid" } },
		});
		expect(request.chain[1]).toMatchObject({
			type: "service",
			service: { metadata: { name: "web", namespace: "default", uid: "service-uid" } },
		});
		expect(request.chain[2]).toMatchObject({
			type: "pod",
			pod: { metadata: { uid: "pod-uid" } },
		});
		expect(response.chain[0]).toEqual(request.chain[2]);
		expect(response.chain[1]).toEqual(request.chain[1]);
		expect(response.chain[2]).toEqual(request.chain[0]);
		const requestID = request.request.header[networkRequestIDHeader]?.[0];
		expect(requestID).toEqual(expect.any(String));
		expect(handlerRequestID).toBe(requestID);
		expect(response.request).toBe(request.request);
		expect(response.response?.header?.[networkRequestIDHeader]).toEqual([requestID]);
		expect(response.response?.header?.["X-App"]).toEqual(["ok"]);
	});

	it("emits request errors without response events when no endpoint is reached", async () => {
		const network = new ClusterNetwork();
		const requests: NetworkRequestEvent[] = [];
		const responses: NetworkResponseEvent[] = [];
		network.on("request", (event) => requests.push(event));
		network.on("response", (event) => responses.push(event));

		await expect(
			network.fetch(context.background(), nodeOrigin("node-1"), "http://10.1.2.3:8080/"),
		).rejects.toThrow("dial tcp 10.1.2.3:8080: connect: connection refused");

		expect(requests).toHaveLength(1);
		expect(responses).toHaveLength(0);
		expect(requests[0]?.latencyMs).toBe(0);
		expect(requests[0]?.error?.message).toBe("dial tcp 10.1.2.3:8080: connect: connection refused");
		expect(requests[0]?.chain.map((hop) => hop.type)).toEqual(["node"]);
	});

	it("waits after request and response events using configured latency", async () => {
		const clock = new Clock();
		clock.pause();
		const network = new ClusterNetwork({ clock });
		const pod = new PodSandboxInstance(
			"sandbox-1",
			{
				metadata: {
					name: "web",
					uid: "pod-uid",
					namespace: "default",
					attempt: 0,
				},
				pod: podOrigin("pod-uid"),
			},
			0,
		);
		const registration = network.setupPodSandbox(pod, "10.244.0.0/24");
		pod.setNetworkRegistration(registration);
		registration.bindHttp(8080, async () => ({ status: 200, body: "ok" }));

		const events: Array<{
			type: string;
			latencyMs: number;
			chain: NetworkHop[];
		}> = [];
		network.on("request", (event) => {
			events.push({
				type: "request",
				latencyMs: event.latencyMs,
				chain: event.chain,
			});
		});
		network.on("response", (event) => {
			events.push({
				type: "response",
				latencyMs: event.latencyMs,
				chain: event.chain,
			});
		});
		const ctx = withLatencyProvider(
			context.background(),
			newLatencyProvider({
				clusterNetworkRequestLatency: (chain) => chain.length * 10,
				clusterNetworkResponseLatency: (chain) => chain.length * 20,
			}),
		);

		let resolved = false;
		const responsePromise = network
			.fetch(ctx, podOrigin("client-uid"), `http://${registration.ip}:8080/`)
			.then((response) => {
				resolved = true;
				return response;
			});

		await waitFor(() => expect(events).toHaveLength(1));
		expect(events).toMatchObject([
			{
				type: "request",
				latencyMs: 20,
				chain: [
					{ type: "pod", pod: { metadata: { uid: "client-uid" } } },
					{ type: "pod", pod: { metadata: { uid: "pod-uid" } } },
				],
			},
		]);
		expect(resolved).toBe(false);
		await waitFor(() => expect(clock.pendingTaskCount()).toBe(1));

		clock.step(20);
		await waitFor(() => expect(events).toHaveLength(2));
		expect(events[1]).toMatchObject({
			type: "response",
			latencyMs: 40,
			chain: [
				{ type: "pod", pod: { metadata: { uid: "pod-uid" } } },
				{ type: "pod", pod: { metadata: { uid: "client-uid" } } },
			],
		});
		expect(resolved).toBe(false);

		clock.step(40);
		await expect(responsePromise).resolves.toMatchObject({ status: 200, body: "ok" });
		expect(resolved).toBe(true);
	});

	it("rejects caller-provided network request IDs", async () => {
		const network = new ClusterNetwork();

		await expect(
			network.fetch(context.background(), nodeOrigin("node-1"), "https://93.184.216.34/", {
				headers: { [networkRequestIDHeader]: "mine" },
			}),
		).rejects.toThrow(`${networkRequestIDHeader} is managed by ClusterNetwork`);
	});
});

function podOrigin(uid: string): V1Pod {
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			name: "web",
			namespace: "default",
			uid,
		},
	};
}

function nodeOrigin(
	name: string,
	addresses: NonNullable<V1Node["status"]>["addresses"] = [],
): V1Node {
	return {
		apiVersion: "v1",
		kind: "Node",
		metadata: { name },
		status: {
			addresses: [{ type: "InternalIP", address: "192.168.1.1" }, ...addresses],
		},
	};
}

function nodePortService(): V1Service {
	return serviceResource("NodePort");
}

function clusterIPService(): V1Service {
	return serviceResource("ClusterIP");
}

function serviceResource(type: "ClusterIP" | "NodePort"): V1Service {
	return {
		apiVersion: "v1",
		kind: "Service",
		metadata: {
			name: "web",
			namespace: "default",
			uid: "service-uid",
		},
		spec: {
			type,
			clusterIP: "10.96.0.10",
			ports: [{ port: 80, targetPort: 8080, nodePort: type === "NodePort" ? 30080 : undefined }],
		},
	};
}
