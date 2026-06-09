/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1Pod } from "../client";
import { isQualifiedName } from "../apimachinery/pkg/api/validate/content/kube";
import { appendQuote } from "../go/strconv";

// Models kubernetes/pkg/fieldpath/fieldpath.go FormatMap.
export function formatMap(m: Record<string, string> | undefined): string {
	const values = m ?? {};
	const keys: string[] = [];
	let grow = 0;
	for (const [key, value] of Object.entries(values)) {
		keys.push(key);
		grow += key.length + value.length + 4;
	}
	keys.sort();
	const dst = new Array<string>(grow);
	dst.length = 0;
	for (const key of keys) {
		if (dst.length > 0) {
			dst.push("\n");
		}
		dst.push(key);
		dst.push("=");
		appendQuote(dst, values[key] ?? "");
	}
	return dst.join("");
}

// Models kubernetes/pkg/fieldpath/fieldpath.go ExtractFieldPathAsString.
export function extractFieldPathAsString(
	pod: V1Pod,
	fieldPath: string,
): [value: string, err: Error | undefined] {
	const [path, subscript, ok] = splitMaybeSubscriptedPath(fieldPath);
	if (ok) {
		switch (path) {
			case "metadata.annotations": {
				const errs = isQualifiedName(subscript.toLowerCase());
				if (errs.length !== 0) {
					return ["", new Error(`invalid key subscript in ${fieldPath}: ${errs.join(";")}`)];
				}
				return [pod.metadata?.annotations?.[subscript] ?? "", undefined];
			}
			case "metadata.labels": {
				const errs = isQualifiedName(subscript);
				if (errs.length !== 0) {
					return ["", new Error(`invalid key subscript in ${fieldPath}: ${errs.join(";")}`)];
				}
				return [pod.metadata?.labels?.[subscript] ?? "", undefined];
			}
			default:
				return ["", new Error(`fieldPath "${fieldPath}" does not support subscript`)];
		}
	}

	switch (fieldPath) {
		case "metadata.annotations":
			return [formatMap(pod.metadata?.annotations), undefined];
		case "metadata.labels":
			return [formatMap(pod.metadata?.labels), undefined];
		case "metadata.name":
			return [pod.metadata?.name ?? "", undefined];
		case "metadata.namespace":
			return [pod.metadata?.namespace ?? "", undefined];
		case "metadata.uid":
			return [pod.metadata?.uid ?? "", undefined];
	}

	return ["", new Error(`unsupported fieldPath: ${fieldPath}`)];
}

// Models kubernetes/pkg/fieldpath/fieldpath.go SplitMaybeSubscriptedPath.
export function splitMaybeSubscriptedPath(
	fieldPath: string,
): [path: string, subscript: string, ok: boolean] {
	if (!fieldPath.endsWith("']")) {
		return [fieldPath, "", false];
	}
	const s = fieldPath.slice(0, -"']".length);
	const parts = s.split("['");
	if (parts.length < 2) {
		return [fieldPath, "", false];
	}
	const path = parts[0] ?? "";
	if (path.length === 0) {
		return [fieldPath, "", false];
	}
	return [path, parts.slice(1).join("['"), true];
}
