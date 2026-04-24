export interface V1NodeStatus {
	allocatable?: { [key: string]: string };
	capacity?: { [key: string]: string };
	phase?: string;
	volumesInUse?: Array<string>;
}
