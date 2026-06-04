import type { ClusterNetwork } from "../../cni";
import type { ProbeResult } from "../probe";

export class TCPProber {
	constructor(private readonly network: ClusterNetwork) {}

	// Models kubernetes/pkg/probe/tcp/tcp.go Probe.
	probe(host: string, port: number, timeoutMs: number): [ProbeResult, string, Error | undefined] {
		return doTCPProbe(this.network, `${host}:${port}`, timeoutMs);
	}
}

// Models kubernetes/pkg/probe/tcp/tcp.go DoTCPProbe.
export function doTCPProbe(
	network: ClusterNetwork,
	addr: string,
	_timeoutMs: number,
): [ProbeResult, string, Error | undefined] {
	const [host, portValue, ...extra] = addr.split(":");
	const port = Number(portValue);
	if (!host || extra.length > 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
		return ["failure", `invalid TCP probe address: ${addr}`, undefined];
	}
	if (!network.canConnect(host, port)) {
		return ["failure", `dial tcp ${addr}: connect: connection refused`, undefined];
	}
	return ["success", "", undefined];
}
