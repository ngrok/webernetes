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

export function isApiError(error: unknown, name: string, code: number): boolean {
	return (
		error instanceof Error &&
		(error.name === name ||
			("code" in error && error.code === code) ||
			error.message.includes(`HTTP-Code: ${code}`))
	);
}
