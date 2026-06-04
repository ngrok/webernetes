import { V1NodeAddress } from "./V1NodeAddress";
import { V1NodeCondition } from "./V1NodeCondition";

export interface V1NodeStatus {
	addresses?: Array<V1NodeAddress>;
	allocatable?: { [key: string]: string };
	capacity?: { [key: string]: string };
	conditions?: Array<V1NodeCondition>;
	phase?: string;
	volumesInUse?: Array<string>;
}
