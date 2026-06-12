/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1LifecycleHandler } from "./V1LifecycleHandler";
export interface V1Lifecycle {
	postStart?: V1LifecycleHandler;
	preStop?: V1LifecycleHandler;
	stopSignal?: string;
}
