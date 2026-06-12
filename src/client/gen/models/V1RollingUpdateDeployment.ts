/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { IntOrString } from "../../types";

export interface V1RollingUpdateDeployment {
	maxSurge?: IntOrString;
	maxUnavailable?: IntOrString;
}
