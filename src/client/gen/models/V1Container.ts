/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1ContainerPort } from "./V1ContainerPort";
import { V1ContainerResizePolicy } from "./V1ContainerResizePolicy";
import { V1ContainerRestartRule } from "./V1ContainerRestartRule";
import { V1EnvFromSource } from "./V1EnvFromSource";
import { V1EnvVar } from "./V1EnvVar";
import { V1Lifecycle } from "./V1Lifecycle";
import { V1Probe } from "./V1Probe";
import { V1ResourceRequirements } from "./V1ResourceRequirements";
import { V1SecurityContext } from "./V1SecurityContext";
import { V1VolumeDevice } from "./V1VolumeDevice";
import { V1VolumeMount } from "./V1VolumeMount";
export interface V1Container {
	args?: Array<string>;
	command?: Array<string>;
	env?: Array<V1EnvVar>;
	envFrom?: Array<V1EnvFromSource>;
	image?: string;
	imagePullPolicy?: string;
	lifecycle?: V1Lifecycle;
	livenessProbe?: V1Probe;
	name: string;
	ports?: Array<V1ContainerPort>;
	readinessProbe?: V1Probe;
	resizePolicy?: Array<V1ContainerResizePolicy>;
	resources?: V1ResourceRequirements;
	restartPolicy?: string;
	restartPolicyRules?: Array<V1ContainerRestartRule>;
	securityContext?: V1SecurityContext;
	startupProbe?: V1Probe;
	stdin?: boolean;
	stdinOnce?: boolean;
	terminationMessagePath?: string;
	terminationMessagePolicy?: string;
	tty?: boolean;
	volumeDevices?: Array<V1VolumeDevice>;
	volumeMounts?: Array<V1VolumeMount>;
	workingDir?: string;
}
