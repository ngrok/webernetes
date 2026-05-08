import type { V1Container } from "../../client";

export function resolvePort(port: number | string, container: V1Container): number | undefined {
	if (typeof port === "number") {
		return validPort(port) ? port : undefined;
	}
	const named = container.ports?.find((candidate) => candidate.name === port)?.containerPort;
	return named !== undefined && validPort(named) ? named : undefined;
}

function validPort(port: number): boolean {
	return Number.isInteger(port) && port > 0 && port <= 65535;
}
