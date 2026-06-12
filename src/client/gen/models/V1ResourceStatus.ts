/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1ResourceHealth } from "./V1ResourceHealth";
export interface V1ResourceStatus {
	name: string;
	resources?: Array<V1ResourceHealth>;
}
