/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// Models staging/src/k8s.io/client-go/util/watchlist/watch_list.go unSupportedWatchListSemantics.
export interface UnsupportedWatchListSemantics {
	isWatchListSemanticsUnsupported(): boolean;
}

// Models staging/src/k8s.io/client-go/util/watchlist/watch_list.go DoesClientNotSupportWatchListSemantics.
export function doesClientNotSupportWatchListSemantics(client: unknown): boolean {
	if (!hasUnsupportedWatchListSemantics(client)) {
		return false;
	}
	return client.isWatchListSemanticsUnsupported();
}

function hasUnsupportedWatchListSemantics(
	client: unknown,
): client is UnsupportedWatchListSemantics {
	return (
		typeof client === "object" &&
		client !== null &&
		"isWatchListSemanticsUnsupported" in client &&
		typeof client.isWatchListSemanticsUnsupported === "function"
	);
}
