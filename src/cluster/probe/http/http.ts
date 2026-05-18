import type { V1Container, V1HTTPGetAction } from "../../../client";
import { NetworkError } from "../../cni";
import type { ContainerInstance, Runtime } from "../../cri";
import type { ProbeResult } from "../probe";
import { resolvePort } from "../util";
import { newRequestForHTTPGetAction } from "./request";

export class HTTPProber {
	constructor(private readonly runtime: Runtime) {}

	// Models kubernetes/pkg/probe/http/http.go Probe.
	async probe(
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

		const [target, request] = newRequestForHTTPGetAction(action, container.sandbox.ip, port);
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
}
