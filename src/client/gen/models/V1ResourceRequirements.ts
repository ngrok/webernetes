import { CoreV1ResourceClaim } from "./CoreV1ResourceClaim";
export interface V1ResourceRequirements {
	claims?: Array<CoreV1ResourceClaim>;
	limits?: {
		[key: string]: string;
	};
	requests?: {
		[key: string]: string;
	};
}
