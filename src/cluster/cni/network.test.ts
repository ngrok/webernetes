import { expect, it, vi } from "vitest";

import type { V1Node, V1Pod } from "../../client";
import * as context from "../../go/context";
import { browser } from "../../test/describe";
import { PodSandboxInstance } from "../cri/runtime";
import { ClusterNetwork } from "./network";

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

		await expect(
			network.fetch(
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
			),
		).resolves.toEqual({
			status: 200,
			body: JSON.stringify({
				method: "POST",
				url: `http://${registration.ip}:8080/echo`,
				header: {
					Host: ["example.test"],
					"X-Test": ["yes"],
				},
				host: "example.test",
				body: "hello",
			}),
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
			},
			0,
		);
		const registration = network.setupPodSandbox(pod, "10.244.0.0/24");
		pod.setNetworkRegistration(registration);

		network.registerNode("node-1", ["192.168.1.1"]);
		network.registerService({
			uid: "service-uid",
			name: "web",
			namespace: "default",
			clusterIp: "10.96.0.10",
			type: "NodePort",
			ports: [{ port: 80, targetPort: 8080, nodePort: 30080 }],
		});
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
			},
			0,
		);
		const registration = network.setupPodSandbox(pod, "10.244.0.0/24");
		pod.setNetworkRegistration(registration);

		network.registerNode("node-1", ["192.168.1.1"]);
		network.registerService({
			uid: "service-uid",
			name: "web",
			namespace: "default",
			clusterIp: "10.96.0.10",
			type: "NodePort",
			ports: [{ port: 80, targetPort: 8080, nodePort: 30080 }],
		});
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
			},
			0,
		);
		const registration = network.setupPodSandbox(pod, "10.244.0.0/24");
		pod.setNetworkRegistration(registration);

		network.registerNode("node-1", ["192.168.1.1"], ["node-1", "node-1.internal.test"]);
		network.registerService({
			uid: "service-uid",
			name: "web",
			namespace: "default",
			clusterIp: "10.96.0.10",
			type: "NodePort",
			ports: [{ port: 80, targetPort: 8080, nodePort: 30080 }],
		});
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
			},
			0,
		);
		const registration = network.setupPodSandbox(pod, "10.244.0.0/24");
		pod.setNetworkRegistration(registration);

		network.registerNode("node-1", ["192.168.1.1"]);
		network.registerService({
			uid: "service-uid",
			name: "web",
			namespace: "default",
			clusterIp: "10.96.0.10",
			type: "NodePort",
			ports: [{ port: 80, targetPort: 8080, nodePort: 30080 }],
		});
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
			},
			0,
		);
		const registration = network.setupPodSandbox(pod, "10.244.0.0/24");
		pod.setNetworkRegistration(registration);

		network.registerService({
			uid: "service-uid",
			name: "web",
			namespace: "default",
			clusterIp: "10.96.0.10",
			type: "ClusterIP",
			ports: [{ port: 80, targetPort: 8080 }],
		});
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

function nodeOrigin(name: string): V1Node {
	return {
		apiVersion: "v1",
		kind: "Node",
		metadata: { name },
		status: {
			addresses: [{ type: "InternalIP", address: "192.168.1.1" }],
		},
	};
}
