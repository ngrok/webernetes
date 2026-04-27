export interface V1ServicePort {
	appProtocol?: string;
	name?: string;
	nodePort?: number;
	port: number;
	protocol?: string;
	targetPort?: number | string;
}
