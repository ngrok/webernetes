import type * as context from "../../go/context";

export type Header = Record<string, string[]>;

export interface Request {
	method: string;
	url: URL;
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

export function formatURL(scheme: string, host: string, port: number, path: string): URL {
	const [pathname, search] = splitPathAndSearch(path);
	const hostPort = `${host}:${port}`;
	const normalizedPathname =
		pathname === "" || pathname.startsWith("/") ? pathname : `/${pathname}`;
	const serializedPathname = pathname === "" ? "" : normalizedPathname;
	const serialized = `${scheme}://${hostPort}${serializedPathname}${search}`;
	const url = new URL(`${scheme}://${hostPort}${normalizedPathname}${search}`);
	Object.defineProperty(url, "toString", { value: () => serialized });
	Object.defineProperty(url, "toJSON", { value: () => serialized });
	return url;
}

function splitPathAndSearch(path: string): [pathname: string, search: string] {
	const index = path.indexOf("?");
	if (index < 0) {
		return [path, ""];
	}
	return [path.slice(0, index), path.slice(index)];
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
