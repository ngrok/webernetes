import type { V1Container, V1TCPSocketAction } from "../../../client";
import type { ClusterNetwork } from "../../cni";
import type { ProbeResult } from "../probe";
import { resolveContainerPort } from "../util";

export class TCPProber {
	constructor(private readonly network: ClusterNetwork) {}

	// Models kubernetes/pkg/probe/tcp/tcp.go Probe.
	probe(
		podIP: string | undefined,
		containerSpec: V1Container,
		action: V1TCPSocketAction,
	): ProbeResult {
		const [port, portErr] = resolveContainerPort(action.port, containerSpec);
		if (portErr) {
			return "failure";
		}
		const host = action.host || podIP || "";
		return this.network.canConnect(host, port) ? "success" : "failure";
	}
}
