/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1Container } from "../../client";

// Models kubernetes/pkg/probe/util.go ResolveContainerPort.
export function resolveContainerPort(
	param: number | string,
	container: V1Container,
): [port: number, err: Error | undefined] {
	let port = -1;
	let err: Error | undefined;
	if (typeof param === "number") {
		port = param;
	} else if (typeof param === "string") {
		[port, err] = findPortByName(container, param);
		if (err) {
			const parsed = Number.parseInt(param, 10);
			if (Number.isNaN(parsed)) {
				return [port, new Error(`invalid port number: ${param}`)];
			}
			port = parsed;
		}
	} else {
		return [port, new Error(`intOrString had no kind: ${JSON.stringify(param)}`)];
	}
	if (validPort(port)) {
		return [port, undefined];
	}
	return [port, new Error(`invalid port number: ${port}`)];
}

// Models kubernetes/pkg/probe/util.go findPortByName.
function findPortByName(
	container: V1Container,
	portName: string,
): [port: number, err: Error | undefined] {
	for (const port of container.ports ?? []) {
		if (port.name === portName) {
			return [port.containerPort, undefined];
		}
	}
	return [0, new Error(`port ${portName} not found`)];
}

function validPort(port: number): boolean {
	return Number.isInteger(port) && port > 0 && port <= 65535;
}
