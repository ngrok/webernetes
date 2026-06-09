import { expect, it } from "vitest";

import * as context from "../../go/context";
import { browser } from "../../test/describe";
import { PodSandboxInstance } from "../cri/runtime";
import { ClusterNetwork } from "./network";

browser.describe("ClusterNetwork", () => {
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
			statusCode: 200,
			body: "ok",
		}));
		await expect(network.fetch(context.background(), "http://10.96.0.10:80/")).resolves.toEqual({
			statusCode: 200,
			body: "ok",
		});

		listener.close();

		await expect(network.fetch(context.background(), "http://10.96.0.10:80/")).rejects.toThrow(
			`dial tcp ${registration.ip}:8080: connect: connection refused`,
		);
	});
});
