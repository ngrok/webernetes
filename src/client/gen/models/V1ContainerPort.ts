export interface V1ContainerPort {
	containerPort: number;
	hostIP?: string;
	hostPort?: number;
	name?: string;
	protocol?: string;
}
