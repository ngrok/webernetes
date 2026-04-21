import { V1ExecAction } from "./V1ExecAction";
import { V1GRPCAction } from "./V1GRPCAction";
import { V1HTTPGetAction } from "./V1HTTPGetAction";
import { V1TCPSocketAction } from "./V1TCPSocketAction";
export interface V1Probe {
	exec?: V1ExecAction;
	failureThreshold?: number;
	grpc?: V1GRPCAction;
	httpGet?: V1HTTPGetAction;
	initialDelaySeconds?: number;
	periodSeconds?: number;
	successThreshold?: number;
	tcpSocket?: V1TCPSocketAction;
	terminationGracePeriodSeconds?: number;
	timeoutSeconds?: number;
}
