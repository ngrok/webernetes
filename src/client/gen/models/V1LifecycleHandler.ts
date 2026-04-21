import { V1ExecAction } from "./V1ExecAction";
import { V1HTTPGetAction } from "./V1HTTPGetAction";
import { V1SleepAction } from "./V1SleepAction";
import { V1TCPSocketAction } from "./V1TCPSocketAction";
export interface V1LifecycleHandler {
	exec?: V1ExecAction;
	httpGet?: V1HTTPGetAction;
	sleep?: V1SleepAction;
	tcpSocket?: V1TCPSocketAction;
}
