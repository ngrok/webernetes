import { Conflict, Invalid } from "../../../errors";
import type { V1DeleteOptions } from "../../models";

interface ListResourceVersionRequest {
	_continue?: string;
	resourceVersion?: string;
	resourceVersionMatch?: string;
}

interface ObjectWithPreconditions {
	kind?: string;
	metadata?: {
		resourceVersion?: string;
		uid?: string;
	};
}

export function listResourceVersionOptions(request: ListResourceVersionRequest): {
	resourceVersion?: string;
} {
	validateListResourceVersionOptions(request);
	if (request.resourceVersionMatch === "Exact") {
		return { resourceVersion: request.resourceVersion };
	}
	return {};
}

export function validateDeletePreconditions(
	kind: string,
	name: string,
	body: V1DeleteOptions | undefined,
	obj: ObjectWithPreconditions,
): void {
	const preconditions = body?.preconditions;
	if (!preconditions) {
		return;
	}

	const resourceVersion = preconditions.resourceVersion;
	const currentResourceVersion = obj.metadata?.resourceVersion ?? "";
	if (resourceVersion && resourceVersion !== currentResourceVersion) {
		throw new Conflict(
			`Operation cannot be fulfilled on ${obj.kind ?? kind} "${name}": the ResourceVersion in the precondition (${resourceVersion}) does not match the ResourceVersion in record (${currentResourceVersion}). The object might have been modified`,
		);
	}

	const uid = preconditions.uid;
	const currentUid = obj.metadata?.uid ?? "";
	if (uid && uid !== currentUid) {
		throw new Conflict(
			`Operation cannot be fulfilled on ${obj.kind ?? kind} "${name}": the UID in the precondition (${uid}) does not match the UID in record (${currentUid}). The object might have been modified`,
		);
	}
}

function validateListResourceVersionOptions(request: ListResourceVersionRequest): void {
	const errors: string[] = [];
	const resourceVersion = request.resourceVersion ?? "";
	const resourceVersionMatch = request.resourceVersionMatch ?? "";

	if (resourceVersionMatch !== "" && resourceVersion === "") {
		errors.push(
			"resourceVersionMatch: Forbidden: resourceVersionMatch is forbidden unless resourceVersion is provided",
		);
	}

	if (
		resourceVersionMatch !== "" &&
		resourceVersionMatch !== "Exact" &&
		resourceVersionMatch !== "NotOlderThan"
	) {
		errors.push(
			`resourceVersionMatch: Unsupported value: "${resourceVersionMatch}": supported values: "Exact", "NotOlderThan", ""`,
		);
	}

	if (resourceVersionMatch === "Exact" && resourceVersion === "0") {
		errors.push(
			'resourceVersionMatch: Forbidden: resourceVersionMatch "exact" is forbidden for resourceVersion "0"',
		);
	}

	if (request._continue && resourceVersionMatch !== "") {
		errors.push("continue: Forbidden: continue may not be specified with resourceVersionMatch");
	}

	if (errors.length === 0) {
		return;
	}

	const detail = errors.length === 1 ? errors[0] : `[${errors.join(", ")}]`;
	throw new Invalid(`ListOptions.meta.k8s.io "" is invalid: ${detail}`);
}
