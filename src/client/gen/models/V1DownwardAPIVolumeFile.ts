/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1ObjectFieldSelector } from "./V1ObjectFieldSelector";
import { V1ResourceFieldSelector } from "./V1ResourceFieldSelector";
export interface V1DownwardAPIVolumeFile {
	fieldRef?: V1ObjectFieldSelector;
	mode?: number;
	path: string;
	resourceFieldRef?: V1ResourceFieldSelector;
}
