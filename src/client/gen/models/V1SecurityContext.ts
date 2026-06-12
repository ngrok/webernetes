/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1AppArmorProfile } from "./V1AppArmorProfile";
import { V1Capabilities } from "./V1Capabilities";
import { V1SELinuxOptions } from "./V1SELinuxOptions";
import { V1SeccompProfile } from "./V1SeccompProfile";
import { V1WindowsSecurityContextOptions } from "./V1WindowsSecurityContextOptions";
export interface V1SecurityContext {
	allowPrivilegeEscalation?: boolean;
	appArmorProfile?: V1AppArmorProfile;
	capabilities?: V1Capabilities;
	privileged?: boolean;
	procMount?: string;
	readOnlyRootFilesystem?: boolean;
	runAsGroup?: number;
	runAsNonRoot?: boolean;
	runAsUser?: number;
	seLinuxOptions?: V1SELinuxOptions;
	seccompProfile?: V1SeccompProfile;
	windowsOptions?: V1WindowsSecurityContextOptions;
}
