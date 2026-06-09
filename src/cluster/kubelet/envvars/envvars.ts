/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1EnvVar, V1Service } from "../../../client";
import { joinHostPort } from "../../../go/net";
import { isServiceIPSet } from "../../apis/core/v1/helper/helpers";

type EnvVar = V1EnvVar & { value: string };

// Models kubernetes/pkg/kubelet/envvars/envvars.go FromServices.
export function fromServices(services: V1Service[]): EnvVar[] {
	const result: EnvVar[] = [];
	for (const service of services) {
		if (!isServiceIPSet(service)) {
			continue;
		}

		const serviceName = service.metadata?.name ?? "";
		const clusterIP = service.spec?.clusterIP ?? "";
		const ports = service.spec?.ports ?? [];
		const firstPort = ports[0];

		let name = `${makeEnvVariableName(serviceName)}_SERVICE_HOST`;
		result.push({ name, value: clusterIP });
		name = `${makeEnvVariableName(serviceName)}_SERVICE_PORT`;
		result.push({ name, value: String(firstPort.port) });
		for (const sp of ports) {
			if (sp.name !== undefined && sp.name !== "") {
				const pn = `${name}_${makeEnvVariableName(sp.name)}`;
				result.push({ name: pn, value: String(sp.port) });
			}
		}
		result.push(...makeLinkVariables(service));
	}
	return result;
}

// Models kubernetes/pkg/kubelet/envvars/envvars.go makeEnvVariableName.
function makeEnvVariableName(str: string): string {
	return str.replaceAll("-", "_").toUpperCase();
}

// Models kubernetes/pkg/kubelet/envvars/envvars.go makeLinkVariables.
function makeLinkVariables(service: V1Service): EnvVar[] {
	const prefix = makeEnvVariableName(service.metadata?.name ?? "");
	const all: EnvVar[] = [];
	const ports = service.spec?.ports ?? [];
	for (let i = 0; i < ports.length; i++) {
		const sp = ports[i];
		const protocol = sp.protocol ?? "TCP";
		const protocolLower = protocol.toLowerCase();
		const hostPort = joinHostPort(service.spec?.clusterIP ?? "", String(sp.port));

		if (i === 0) {
			all.push({
				name: `${prefix}_PORT`,
				value: `${protocolLower}://${hostPort}`,
			});
		}
		const portPrefix = `${prefix}_PORT_${sp.port}_${protocol.toUpperCase()}`;
		all.push(
			{
				name: portPrefix,
				value: `${protocolLower}://${hostPort}`,
			},
			{
				name: `${portPrefix}_PROTO`,
				value: protocolLower,
			},
			{
				name: `${portPrefix}_PORT`,
				value: String(sp.port),
			},
			{
				name: `${portPrefix}_ADDR`,
				value: service.spec?.clusterIP ?? "",
			},
		);
	}
	return all;
}
