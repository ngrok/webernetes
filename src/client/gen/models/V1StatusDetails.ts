/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1StatusCause } from "./V1StatusCause";

export interface V1StatusDetails {
	causes?: Array<V1StatusCause>;
	group?: string;
	kind?: string;
	name?: string;
	retryAfterSeconds?: number;
	uid?: string;
}
