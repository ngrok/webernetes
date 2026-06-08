import { deepMerge } from "../../../deep-merge";
import type { DeepPartial } from "../../../utility-types";
import { V1NodeSwapStatus } from "./V1NodeSwapStatus";

export interface V1NodeSystemInfo {
	architecture: string;
	bootID: string;
	containerRuntimeVersion: string;
	kernelVersion: string;
	kubeProxyVersion: string;
	kubeletVersion: string;
	machineID: string;
	operatingSystem: string;
	osImage: string;
	swap?: V1NodeSwapStatus;
	systemUUID: string;
}

export function newNodeSystemInfo(
	nodeSystemInfo: DeepPartial<V1NodeSystemInfo> = {},
): V1NodeSystemInfo {
	return deepMerge<V1NodeSystemInfo>(
		{
			architecture: "",
			bootID: "",
			containerRuntimeVersion: "",
			kernelVersion: "",
			kubeProxyVersion: "",
			kubeletVersion: "",
			machineID: "",
			operatingSystem: "",
			osImage: "",
			systemUUID: "",
		},
		nodeSystemInfo,
	);
}
