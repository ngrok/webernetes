export interface V1Condition {
	lastTransitionTime: Date;
	message: string;
	observedGeneration?: number;
	reason: string;
	status: string;
	type: string;
}
