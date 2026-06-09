/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1Service } from "../../../../../client";

// Models kubernetes/pkg/apis/core/v1/helper/helpers.go IsServiceIPSet.
export function isServiceIPSet(service: V1Service): boolean {
	const clusterIP = service.spec?.clusterIP ?? "";
	return clusterIP !== "None" && clusterIP !== "";
}
