import { BadRequest, Conflict, Invalid, NotFound, UnsupportedMediaType } from "../../../errors";
import { V1Status } from "../../models";

export class ApiException<T> extends Error {
	code: number;
	body: T;

	constructor(code: number, body: T) {
		const message = `HTTP-Code: ${code}\nMessage: Unknown API Status Code!\nBody: "${JSON.stringify(body)}"`;
		super(message);
		this.code = code;
		this.body = body;
	}
}

export async function rethrowApiErrors<T>(f: () => Promise<T>): Promise<T> {
	try {
		return await f();
	} catch (e: unknown) {
		if (!(e instanceof Error)) {
			throw new ApiException<V1Status>(500, {
				apiVersion: "v1",
				kind: "Status",
				status: "Failure",
				message: String(e),
				reason: undefined,
				code: undefined,
			});
		}

		let code = 500;
		if (e instanceof BadRequest) {
			code = 400;
		} else if (e instanceof Invalid) {
			code = 422;
		} else if (e instanceof NotFound) {
			code = 404;
		} else if (e instanceof Conflict) {
			code = 409;
		} else if (e instanceof UnsupportedMediaType) {
			code = 415;
		}

		const status: V1Status = {
			apiVersion: "v1",
			kind: "Status",
			status: "Failure",
			message: e.message,
			reason: e.name,
			code,
		};
		throw new ApiException<V1Status>(code, status);
	}
}
