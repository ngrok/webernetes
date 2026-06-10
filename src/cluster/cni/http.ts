import type * as context from "../../go/context";

export type Header = Record<string, string[]>;
export type FetchInput = string | globalThis.URL;
export type HeadersInit =
	| Record<string, string | readonly string[]>
	| Iterable<readonly [string, string]>
	| { forEach(callback: (value: string, name: string) => void): void };

export interface FetchInit {
	method?: string;
	headers?: HeadersInit;
	body?: string;
}

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
	status: number;
	header?: Header;
	body: string;
}

export type Handler = (ctx: context.Context, request: Request) => Promise<Response>;

export function headerFromInit(headers: HeadersInit | undefined): Header {
	const normalized: Header = {};
	if (!headers) {
		return normalized;
	}
	if (Symbol.iterator in Object(headers)) {
		for (const [name, value] of headers as Iterable<readonly [string, string]>) {
			headerAppend(normalized, name, value);
		}
		return normalized;
	}
	if (
		typeof headers === "object" &&
		"forEach" in headers &&
		typeof headers.forEach === "function"
	) {
		headers.forEach((value, name) => headerAppend(normalized, name, value));
		return normalized;
	}
	for (const [name, value] of Object.entries(headers)) {
		for (const headerValue of Array.isArray(value) ? value : [value]) {
			headerAppend(normalized, name, headerValue);
		}
	}
	return normalized;
}

export function headerClone(headers: Header): Header {
	const cloned: Header = {};
	for (const [name, values] of Object.entries(headers)) {
		cloned[name] = [...values];
	}
	return cloned;
}

export function headerEntries(headers: Header): Array<[string, string]> {
	const entries: Array<[string, string]> = [];
	for (const [name, values] of Object.entries(headers)) {
		for (const value of values) {
			entries.push([name, value]);
		}
	}
	return entries;
}

export function headerAppend(headers: Header, name: string, value: string): void {
	const key = headerKey(headers, name) ?? name;
	(headers[key] ??= []).push(value);
}

export function headerSet(headers: Header, name: string, value: string): void {
	const key = headerKey(headers, name) ?? name;
	headers[key] = [value];
}

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
