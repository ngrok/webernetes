export class NotFound extends Error {
	name = "NotFound";
}

export class Conflict extends Error {
	name = "Conflict";
}

export class BadRequest extends Error {
	name = "BadRequest";
}

export class Invalid extends Error {
	name = "Invalid";
}

export class UnsupportedMediaType extends Error {
	name = "UnsupportedMediaType";
}

export function isNotFoundError(error: unknown): boolean {
	return isApiError(error, "NotFound", 404);
}

export function isConflictError(error: unknown): boolean {
	return isApiError(error, "Conflict", 409);
}

export function isInvalidError(error: unknown): boolean {
	return isApiError(error, "Invalid", 422);
}

export function isUnsupportedMediaTypeError(error: unknown): boolean {
	return isApiError(error, "UnsupportedMediaType", 415);
}

export function hasStatusCause(error: unknown, name: string): boolean {
	if (!(error instanceof Error) || !("body" in error)) {
		return false;
	}
	const body = error.body;
	if (!isRecord(body) || !isRecord(body.details) || !Array.isArray(body.details.causes)) {
		return false;
	}
	return body.details.causes.some((cause) => isRecord(cause) && cause.reason === name);
}

export function isApiError(error: unknown, name: string, code: number): boolean {
	return (
		error instanceof Error &&
		(error.name === name ||
			("code" in error && error.code === code) ||
			error.message.includes(`HTTP-Code: ${code}`))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
