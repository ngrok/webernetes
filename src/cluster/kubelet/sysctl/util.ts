import type { V1PodSecurityContext } from "../../../client";
import { normalizeName } from "../../../component-helpers/node/util/sysctl";

// Models kubernetes/pkg/kubelet/sysctl/util.go ConvertPodSysctlsVariableToDotsSeparator.
export function convertPodSysctlsVariableToDotsSeparator(
	securityContext: V1PodSecurityContext | undefined,
): void {
	if (securityContext === undefined) {
		return;
	}
	for (const sysctl of securityContext.sysctls ?? []) {
		sysctl.name = normalizeName(sysctl.name ?? "");
	}
}
