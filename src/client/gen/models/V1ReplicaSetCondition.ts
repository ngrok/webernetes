export interface V1ReplicaSetCondition {
	lastTransitionTime?: Date;
	message?: string;
	reason?: string;
	status: string;
	type: string;
}
