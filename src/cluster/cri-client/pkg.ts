/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// Models k8s.io/cri-client/pkg ErrCommandTimedOut.
export const errCommandTimedOut = new Error("command timed out");

// Models k8s.io/cri-client/pkg ErrCommandTimedOut wrapping in exec sync timeout errors.
export function newCommandTimedOutError(command: readonly string[]): Error {
	return new Error(`${errCommandTimedOut.message}: command ${command.join(" ")} timed out`, {
		cause: errCommandTimedOut,
	});
}
