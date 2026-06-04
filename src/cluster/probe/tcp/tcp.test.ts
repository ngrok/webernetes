import { expect, it } from "vitest";

import { browser } from "../../../test/describe";
import { ClusterNetwork } from "../../cni";
import { PodSandboxInstance } from "../../cri";
import type { ProbeResult } from "../probe";
import { TCPProber } from "./tcp";

function bindTestHTTP(network: ClusterNetwork, port: number): string {
	const sandbox = new PodSandboxInstance(
		"sandbox-id",
		{
			metadata: { uid: "pod-uid", name: "pod", namespace: "default", attempt: 0 },
			dnsConfig: { servers: [], searches: [], options: [] },
		},
		0,
	);
	const registration = network.setupPodSandbox(sandbox, "10.0.0.0/24");
	sandbox.setNetworkRegistration(registration);
	registration.bindHttp(port, async () => ({ statusCode: 200, body: "" }));
	return registration.ip;
}

// Models kubernetes/pkg/probe/tcp/tcp_test.go TestTcpHealthChecker.
browser.describe("TCPProber", () => {
	it("checks TCP health", () => {
		const network = new ClusterNetwork();
		const host = bindTestHTTP(network, 8080);
		const prober = new TCPProber(network);

		const tests: Array<{
			host: string;
			port: number;
			expectedStatus: ProbeResult;
			expectedError: Error | undefined;
		}> = [
			{ host, port: 8080, expectedStatus: "success", expectedError: undefined },
			{ host, port: -1, expectedStatus: "failure", expectedError: undefined },
		];

		for (const tt of tests) {
			const [status, , err] = prober.probe(tt.host, tt.port, 1000);
			expect(status).toBe(tt.expectedStatus);
			expect(err).toBe(tt.expectedError);
		}
	});
});
