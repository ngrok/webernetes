import { expect, it } from "vitest";

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
			network.fetch(context.background(), `http://${registration.ip}:8080/echo`, {
				method: "POST",
				headers: {
					Host: "example.test",
					"X-Test": "yes",
				},
				body: "hello",
			}),
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
			network.fetch(context.background(), "http://192.168.1.1:30080/path"),
		).resolves.toEqual({
			status: 200,
			body: "http://192.168.1.1:30080/path",
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

		await expect(network.fetch(context.background(), "http://192.168.1.1:30080/")).resolves.toEqual(
			{
				status: 200,
				body: "ok",
			},
		);

		network.unregisterNode("node-1");

		await expect(network.fetch(context.background(), "http://192.168.1.1:30080/")).rejects.toThrow(
			"dial tcp 192.168.1.1:30080: connect: connection refused",
		);
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
		await expect(network.fetch(context.background(), "http://10.96.0.10:80/")).resolves.toEqual({
			status: 200,
			body: "ok",
		});

		listener.close();

		await expect(network.fetch(context.background(), "http://10.96.0.10:80/")).rejects.toThrow(
			`dial tcp ${registration.ip}:8080: connect: connection refused`,
		);
	});
});
