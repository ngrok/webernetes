import type { V1Container, V1HTTPGetAction, V1Probe, V1TCPSocketAction } from "../../client";
import type { ContainerInstance, Runtime } from "../cri";
import { NetworkError } from "../cni";
import type { HttpRequest } from "../cni";
import type { ProbeResult } from "./results";

const MAX_PROBE_RETRIES = 3;

export class Prober {
	constructor(private readonly runtime: Runtime) {}

	async probe(
		container: ContainerInstance,
		containerSpec: V1Container,
		probe: V1Probe,
		timeoutMs: number,
	): Promise<ProbeResult> {
		for (let attempt = 0; attempt < MAX_PROBE_RETRIES; attempt++) {
			try {
				return await this.runProbe(container, containerSpec, probe, timeoutMs);
			} catch {
				if (attempt === MAX_PROBE_RETRIES - 1) {
					return "unknown";
				}
			}
		}
		return "unknown";
	}

	private async runProbe(
		container: ContainerInstance,
		containerSpec: V1Container,
		probe: V1Probe,
		timeoutMs: number,
	): Promise<ProbeResult> {
		if (probe.exec) {
			const result = await this.runtime.execSync(
				container.id,
				expandCommand(probe.exec.command ?? [], container.env),
				{ timeoutMs },
			);
			return result.exitCode === 0 ? "success" : "failure";
		}
		if (probe.httpGet) {
			return await this.httpGet(container, containerSpec, probe.httpGet);
		}
		if (probe.tcpSocket) {
			return this.tcpSocket(container, containerSpec, probe.tcpSocket);
		}
		return "failure";
	}

	private async httpGet(
		container: ContainerInstance,
		containerSpec: V1Container,
		action: V1HTTPGetAction,
	): Promise<ProbeResult> {
		if (action.scheme && action.scheme !== "HTTP") {
			return "failure";
		}
		const port = resolvePort(action.port, containerSpec);
		if (port === undefined) {
			return "failure";
		}

		const podIp = container.pod.ip;
		const requestHost = action.host;
		const path = action.path ?? "/";
		const target = `http://${podIp}:${port}${path.startsWith("/") ? path : `/${path}`}`;
		const headers = probeHeaders(action.httpHeaders, requestHost);
		const request: HttpRequest = { method: "GET", headers };
		try {
			const response = await this.runtime.network.fetch(target, request);
			return response.status >= 200 && response.status < 400 ? "success" : "failure";
		} catch (error) {
			if (error instanceof NetworkError) {
				return "failure";
			}
			throw error;
		}
	}

	private tcpSocket(
		container: ContainerInstance,
		containerSpec: V1Container,
		action: V1TCPSocketAction,
	): ProbeResult {
		const port = resolvePort(action.port, containerSpec);
		if (port === undefined) {
			return "failure";
		}
		const host = action.host || container.pod.ip;
		return this.runtime.network.canConnect(host, port) ? "success" : "failure";
	}
}

function resolvePort(port: number | string, container: V1Container): number | undefined {
	if (typeof port === "number") {
		return validPort(port) ? port : undefined;
	}
	const named = container.ports?.find((candidate) => candidate.name === port)?.containerPort;
	return named !== undefined && validPort(named) ? named : undefined;
}

function validPort(port: number): boolean {
	return Number.isInteger(port) && port > 0 && port <= 65535;
}

function probeHeaders(
	headers: V1HTTPGetAction["httpHeaders"],
	host: string | undefined,
): Record<string, string> {
	const result: Record<string, string> = {
		"User-Agent": "kube-probe/simulator",
		Accept: "*/*",
	};
	if (host) {
		result.Host = host;
	}
	for (const header of headers ?? []) {
		const name = header.name;
		if (!name) {
			continue;
		}
		if (name.toLowerCase() === "accept" && header.value === "") {
			for (const key of Object.keys(result)) {
				if (key.toLowerCase() === "accept") {
					delete result[key];
				}
			}
			continue;
		}
		result[name] = header.value ?? "";
	}
	return result;
}

function expandCommand(command: readonly string[], env: ReadonlyMap<string, string>): string[] {
	return command.map((arg) =>
		arg.replace(
			/\$\(([-._a-zA-Z][-._a-zA-Z0-9]*)\)/g,
			(match, name: string) => env.get(name) ?? match,
		),
	);
}
