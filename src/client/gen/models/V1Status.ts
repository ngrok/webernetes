/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1ListMeta } from "./V1ListMeta";
import { V1StatusDetails } from "./V1StatusDetails";

export interface V1Status {
	apiVersion?: string;
	code?: number;
	details?: V1StatusDetails;
	kind?: string;
	message?: string;
	metadata?: V1ListMeta;
	reason?: string;
	status?: string;
}
