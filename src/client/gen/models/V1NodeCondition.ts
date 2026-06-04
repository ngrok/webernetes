export interface V1NodeCondition {
	lastHeartbeatTime?: Date;
	lastTransitionTime?: Date;
	message?: string;
	reason?: string;
	status: string;
	type: string;
}
