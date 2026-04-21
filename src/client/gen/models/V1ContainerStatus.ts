import { V1ContainerState } from "./V1ContainerState";
import { V1ContainerUser } from "./V1ContainerUser";
import { V1ResourceRequirements } from "./V1ResourceRequirements";
import { V1ResourceStatus } from "./V1ResourceStatus";
import { V1VolumeMountStatus } from "./V1VolumeMountStatus";
export interface V1ContainerStatus {
	allocatedResources?: {
		[key: string]: string;
	};
	allocatedResourcesStatus?: Array<V1ResourceStatus>;
	containerID?: string;
	image: string;
	imageID: string;
	lastState?: V1ContainerState;
	name: string;
	ready: boolean;
	resources?: V1ResourceRequirements;
	restartCount: number;
	started?: boolean;
	state?: V1ContainerState;
	stopSignal?: string;
	user?: V1ContainerUser;
	volumeMounts?: Array<V1VolumeMountStatus>;
}
