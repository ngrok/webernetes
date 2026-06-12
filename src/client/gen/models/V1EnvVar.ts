/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1EnvVarSource } from "./V1EnvVarSource";
export interface V1EnvVar {
	name: string;
	value?: string;
	valueFrom?: V1EnvVarSource;
}
