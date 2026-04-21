export interface V1ContainerStateTerminated {
	containerID?: string;
	exitCode: number;
	finishedAt?: Date;
	message?: string;
	reason?: string;
	signal?: number;
	startedAt?: Date;
}
