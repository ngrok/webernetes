// Copying from:
//   kubernetes/kubernetes/staging/src/k8s.io/api/core/v1/types.go
import type { TypeMeta, ObjectMeta } from "../../meta/v1/types";

export interface Pod extends TypeMeta, ObjectMeta {
	spec?: PodSpec;
	status?: PodStatus;
}

export interface PodSpec {
	containers: ContainerSpec[];
	nodeName?: string;
	restartPolicy?: "Always" | "Never";
	terminationGracePeriodSeconds?: number;
}

export interface ContainerState {
	running?: ContainerStateRunning;
	terminated?: ContainerStateTerminated;
	waiting?: ContainerStateWaiting;
}

export interface ContainerStateRunning {
	startedAt: Date;
}

export interface ContainerStateTerminated {
	containerID: string;
	exitCode: number;
	finishedAt: Date;
}

export interface ContainerStateWaiting {
	reason: string;
}

export interface ContainerStatus {
	containerID: string;
	name: string;
	ready: boolean;
	restartCount: number;
	started: boolean;
	state: ContainerState;
}

export type PodConditionType =
	| "Ready"
	| "PodScheduled"
	| "PodReadyToStartContainers"
	| "ContainersReady"
	| "Initialized"
	| "PodResizePending"
	| "PodResizeInProgress"
	| "DisruptionTarget";

export type PodConditionStatus = "True" | "False" | "Unknown";

export interface PodCondition {
	type: PodConditionType;
	status: PodConditionStatus;
	reason?: string;
	message?: string;
}

export type Phase = "Pending" | "Running" | "Succeeded" | "Failed";

export interface PodStatus {
	conditions: PodCondition[];
	phase: Phase;
	containerStatuses: ContainerStatus[];
	message?: string;
	reason?: string;
}

export interface HttpGet {
	path: string;
	port: number;
	headers?: Record<string, string>;
}

export interface ProbeSpec {
	initialDelaySeconds?: number;
	periodSeconds?: number;
	timeoutSeconds?: number;
	failureThreshold?: number;
	successThreshold?: number;
	terminationGracePeriodSeconds?: number;
	httpGet?: HttpGet;
}

export interface ContainerSpec {
	name: string;
	livenessProbe?: ProbeSpec;
	readinessProbe?: ProbeSpec;
	startupProbe?: ProbeSpec;
}

export interface NodeSpec {}

export interface NodeStatus {}

export interface Node extends TypeMeta, ObjectMeta {
	spec?: NodeSpec;
	status?: NodeStatus;
}
