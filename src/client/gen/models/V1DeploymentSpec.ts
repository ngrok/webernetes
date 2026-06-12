/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { V1DeploymentStrategy } from "./V1DeploymentStrategy";
import { V1LabelSelector } from "./V1LabelSelector";
import { V1PodTemplateSpec } from "./V1PodTemplateSpec";

export interface V1DeploymentSpec {
	minReadySeconds?: number;
	paused?: boolean;
	progressDeadlineSeconds?: number;
	replicas?: number;
	revisionHistoryLimit?: number;
	selector: V1LabelSelector;
	strategy?: V1DeploymentStrategy;
	template: V1PodTemplateSpec;
}
