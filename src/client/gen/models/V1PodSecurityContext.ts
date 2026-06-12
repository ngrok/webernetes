/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1AppArmorProfile } from "./V1AppArmorProfile";
import { V1SELinuxOptions } from "./V1SELinuxOptions";
import { V1SeccompProfile } from "./V1SeccompProfile";
import { V1Sysctl } from "./V1Sysctl";
import { V1WindowsSecurityContextOptions } from "./V1WindowsSecurityContextOptions";
export interface V1PodSecurityContext {
	appArmorProfile?: V1AppArmorProfile;
	fsGroup?: number;
	fsGroupChangePolicy?: string;
	runAsGroup?: number;
	runAsNonRoot?: boolean;
	runAsUser?: number;
	seLinuxOptions?: V1SELinuxOptions;
	seccompProfile?: V1SeccompProfile;
	supplementalGroups?: Array<number>;
	supplementalGroupsPolicy?: string;
	sysctls?: Array<V1Sysctl>;
	windowsOptions?: V1WindowsSecurityContextOptions;
}
