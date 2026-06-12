/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1MicroTime } from "../../types";

export interface CoreV1EventSeries {
	count?: number;
	lastObservedTime?: V1MicroTime;
}
