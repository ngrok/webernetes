/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1Container, V1HTTPGetAction } from "../../../client";
import * as http from "../../cni/http";
import { resolveContainerPort } from "../util";

export const healthCheckHeader = "X-Webernetes-Health-Check";

// Models kubernetes/pkg/probe/http/request.go NewProbeRequest.
export function newProbeRequest(
	url: URL,
	headers: http.Header,
): [http.Request | undefined, Error | undefined] {
	return newProbeRequestWithUserAgent(url, headers, "probe");
}

// Models kubernetes/pkg/probe/http/request.go newProbeRequest.
function newProbeRequestWithUserAgent(
	url: URL,
	headers: http.Header | undefined,
	userAgentFragment: string,
): [http.Request | undefined, Error | undefined] {
	headers ??= {};
	if (!http.hasHeader(headers, "User-Agent")) {
		headers["User-Agent"] = [userAgent(userAgentFragment)];
	}
	if (!http.hasHeader(headers, "Accept")) {
		headers.Accept = ["*/*"];
	} else if (http.headerGet(headers, "Accept") === "") {
		http.headerDel(headers, "Accept");
	}
	return [
		{
			method: "GET",
			url,
			header: headers,
			host: http.headerGet(headers, "Host"),
		},
		undefined,
	];
}

// Models kubernetes/pkg/probe/http/request.go NewRequestForHTTPGetAction.
export function newRequestForHTTPGetAction(
	httpGet: V1HTTPGetAction,
	container: V1Container,
	podIP: string,
	userAgentFragment: string,
): [http.Request | undefined, Error | undefined] {
	let scheme = (httpGet.scheme ?? "").toLowerCase();
	if (scheme === "") {
		scheme = "http";
	}

	let host = httpGet.host ?? "";
	if (host === "") {
		host = podIP;
	}

	const [port, err] = resolveContainerPort(httpGet.port, container);
	if (err) {
		return [undefined, err];
	}

	const path = httpGet.path ?? "";
	const url = formatURL(scheme, host, port, path);
	const headers = v1HeaderToHTTPHeader(httpGet.httpHeaders ?? []);

	return newProbeRequestWithUserAgent(url, headers, userAgentFragment);
}

function userAgent(purpose: string): string {
	return `kube-${purpose}/1.36`;
}

// Models kubernetes/pkg/probe/http/request.go formatURL.
export function formatURL(scheme: string, host: string, port: number, path: string): URL {
	const parsed = parseURLPath(path);
	const hostPort = `${host}:${port}`;
	return new http.URL(`${scheme}://${hostPort}${parsed.path}${parsed.search}${parsed.hash}`);
}

function parseURLPath(path: string): {
	path: string;
	search: string;
	hash: string;
} {
	try {
		const absolute = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(path) || path.startsWith("//");
		const parsed = absolute ? new URL(path) : new URL(path || "/", "http://placeholder");
		const rawPath = path.split(/[?#]/, 1)[0] ?? "";
		const serializedPath = rawPath === "" ? "" : parsed.pathname;
		return {
			path: serializedPath,
			search: parsed.search,
			hash: parsed.hash,
		};
	} catch {
		const [rawPath, search, hash] = splitPathSearchHash(path);
		const serializedPath = rawPath === "" || rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
		return { path: serializedPath, search, hash };
	}
}

function splitPathSearchHash(path: string): [path: string, search: string, hash: string] {
	const hashIndex = path.indexOf("#");
	const beforeHash = hashIndex < 0 ? path : path.slice(0, hashIndex);
	const hash = hashIndex < 0 ? "" : path.slice(hashIndex);
	const searchIndex = beforeHash.indexOf("?");
	if (searchIndex < 0) {
		return [beforeHash, "", hash];
	}
	return [beforeHash.slice(0, searchIndex), beforeHash.slice(searchIndex), hash];
}

// Models kubernetes/pkg/probe/http/request.go v1HeaderToHTTPHeader.
export function v1HeaderToHTTPHeader(
	headerList: NonNullable<V1HTTPGetAction["httpHeaders"]>,
): http.Header {
	const headers: http.Header = {};
	for (const header of headerList) {
		const name = canonicalHeaderKey(header.name);
		const existing = headers[name] ?? [];
		existing.push(header.value ?? "");
		headers[name] = existing;
	}
	return headers;
}

function canonicalHeaderKey(value: string): string {
	return value
		.toLowerCase()
		.split("-")
		.map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
		.join("-");
}
