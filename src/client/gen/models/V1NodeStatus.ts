import { V1NodeAddress } from "./V1NodeAddress";

export interface V1NodeStatus {
	addresses?: Array<V1NodeAddress>;
	allocatable?: { [key: string]: string };
	capacity?: { [key: string]: string };
	phase?: string;
	volumesInUse?: Array<string>;
}
