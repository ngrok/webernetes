export interface V1PodCondition {
	lastProbeTime?: Date;
	lastTransitionTime?: Date;
	message?: string;
	observedGeneration?: number;
	reason?: string;
	status: string;
	type: string;
}
