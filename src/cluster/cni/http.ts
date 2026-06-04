import type * as context from "../../go/context";

export type Header = Record<string, string[]>;

export class URL extends globalThis.URL {
	private readonly raw: string;

	constructor(url: string) {
		super(url);
		this.raw = url;
	}

	override toString(): string {
		return this.raw;
	}

	override toJSON(): string {
		return this.raw;
	}
}

export interface Request {
	method: string;
	url: globalThis.URL;
	header: Header;
	host: string;
	body?: string;
}

export interface Response {
	statusCode: number;
	header?: Header;
	body: string;
}

export type Handler = (ctx: context.Context, request: Request) => Promise<Response>;

export function headerGet(headers: Header, name: string): string {
	const key = headerKey(headers, name);
	return key ? (headers[key]?.[0] ?? "") : "";
}

export function hasHeader(headers: Header, name: string): boolean {
	return headerKey(headers, name) !== undefined;
}

export function headerDel(headers: Header, name: string): void {
	const key = headerKey(headers, name);
	if (key) {
		delete headers[key];
	}
}

export function headerKey(headers: Header, name: string): string | undefined {
	const lowerName = name.toLowerCase();
	return Object.keys(headers).find((key) => key.toLowerCase() === lowerName);
}

export class Listener {
	private closed = false;

	constructor(
		readonly ip: string,
		readonly port: number,
		private readonly onClose: () => void,
	) {}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.onClose();
	}
}
