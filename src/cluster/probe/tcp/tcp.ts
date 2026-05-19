import type { V1Container, V1TCPSocketAction } from "../../../client";
import type { ClusterNetwork } from "../../cni";
import type { ProbeResult } from "../probe";
import { resolvePort } from "../util";

export class TCPProber {
	constructor(private readonly network: ClusterNetwork) {}

	// Models kubernetes/pkg/probe/tcp/tcp.go Probe.
	probe(
		podIP: string | undefined,
		containerSpec: V1Container,
		action: V1TCPSocketAction,
	): ProbeResult {
		const port = resolvePort(action.port, containerSpec);
		if (port === undefined) {
			return "failure";
		}
		const host = action.host || podIP || "";
		return this.network.canConnect(host, port) ? "success" : "failure";
	}
}
