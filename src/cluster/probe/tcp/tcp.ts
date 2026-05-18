import type { V1Container, V1TCPSocketAction } from "../../../client";
import type { ContainerInstance, Runtime } from "../../cri";
import type { ProbeResult } from "../probe";
import { resolvePort } from "../util";

export class TCPProber {
	constructor(private readonly runtime: Runtime) {}

	// Models kubernetes/pkg/probe/tcp/tcp.go Probe.
	probe(
		container: ContainerInstance,
		containerSpec: V1Container,
		action: V1TCPSocketAction,
	): ProbeResult {
		const port = resolvePort(action.port, containerSpec);
		if (port === undefined) {
			return "failure";
		}
		const host = action.host || container.sandbox.ip;
		return this.runtime.network.canConnect(host, port) ? "success" : "failure";
	}
}
