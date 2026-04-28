export interface ServiceInstance {
	readonly uid: string;
	readonly name: string;
	readonly namespace: string;
	readonly clusterIp: string;
	readonly type: "ClusterIP" | "NodePort";
	readonly ports: readonly ServicePort[];
}

export interface ServicePort {
	name?: string;
	port: number;
	targetPort: number | string;
	nodePort?: number;
	protocol?: "TCP" | "UDP" | "SCTP";
}

export interface ServiceEndpoint {
	ip: string;
	port: number;
}
