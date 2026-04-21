import { V1ResourceHealth } from "./V1ResourceHealth";
export interface V1ResourceStatus {
	name: string;
	resources?: Array<V1ResourceHealth>;
}
