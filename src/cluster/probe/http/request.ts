import type { V1HTTPGetAction } from "../../../client";
import type { HttpRequest } from "../../cni";

export function newRequestForHTTPGetAction(
	action: V1HTTPGetAction,
	podIp: string,
	port: number,
): [string, HttpRequest] {
	const requestHost = action.host;
	const path = action.path ?? "/";
	const target = `http://${podIp}:${port}${path.startsWith("/") ? path : `/${path}`}`;
	return [target, { method: "GET", headers: probeHeaders(action.httpHeaders, requestHost) }];
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
