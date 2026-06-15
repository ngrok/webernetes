/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1Deployment } from "../../client";
import { labelSelectorAsSelector } from "../../apimachinery/pkg/apis/meta/v1/helpers";
import { Set as LabelSet } from "../../apimachinery/pkg/labels/labels";
import { Invalid } from "../../client/errors";
import { Etcd } from "../etcd";
import { formatLabelSelector, formatStringMap } from "./helpers";
import { Store } from "./store";

export class DeploymentStore extends Store<V1Deployment> {
	constructor(etcd: Etcd) {
		super(etcd, {
			apiVersion: "apps/v1",
			defaultQualifiedResource: "deployments",
			kind: "Deployment",
			singularQualifiedResource: "deployment.apps",
			namespaced: true,
		});
	}

	protected override async prepareCreate(deployment: V1Deployment): Promise<void> {
		defaultDeployment(deployment);
	}

	protected override async prepareUpdate(
		deployment: V1Deployment,
		existing: V1Deployment,
	): Promise<void> {
		defaultDeployment(deployment);
		deployment.status ??= existing.status;
	}

	protected override async validateCreate(deployment: V1Deployment): Promise<void> {
		validateDeployment(deployment);
	}

	protected override async validateUpdate(
		deployment: V1Deployment,
		existing: V1Deployment,
	): Promise<void> {
		validateDeployment(deployment);
		if (JSON.stringify(deployment.spec?.selector) !== JSON.stringify(existing.spec?.selector)) {
			throw new Invalid(
				`Deployment.apps "${deployment.metadata?.name}" is invalid: spec.selector: Invalid value: ${formatLabelSelector(deployment.spec?.selector)}: field is immutable`,
			);
		}
	}
}

// Models kubernetes/pkg/apis/apps/v1/defaults.go SetDefaults_Deployment.
function defaultDeployment(deployment: V1Deployment): void {
	deployment.spec ??= {
		selector: {},
		template: {},
	};
	deployment.spec.replicas ??= 1;
	deployment.spec.strategy ??= {};
	deployment.spec.strategy.type ??= "RollingUpdate";
	if (deployment.spec.strategy.type === "RollingUpdate") {
		deployment.spec.strategy.rollingUpdate ??= {};
		deployment.spec.strategy.rollingUpdate.maxUnavailable ??= "25%";
		deployment.spec.strategy.rollingUpdate.maxSurge ??= "25%";
	}
	deployment.spec.revisionHistoryLimit ??= 10;
	deployment.spec.progressDeadlineSeconds ??= 600;
	deployment.status ??= {};
}

// Models kubernetes/pkg/apis/apps/validation/validation.go ValidateDeploymentSpec.
function validateDeployment(deployment: V1Deployment): void {
	const name = deployment.metadata?.name ?? "";
	const spec = deployment.spec;
	if (!spec) {
		throw new Invalid(`Deployment.apps "${name}" is invalid: spec: Required value`);
	}
	const [selector, selectorErr] = labelSelectorAsSelector(spec.selector);
	if (!spec.selector || selector?.empty()) {
		throw new Invalid(`Deployment.apps "${name}" is invalid: spec.selector: Required value`);
	}
	if (selectorErr) {
		throw new Invalid(
			`Deployment.apps "${name}" is invalid: spec.selector: Invalid value: ${formatLabelSelector(spec.selector)}: ${selectorErr.message}`,
		);
	}
	if (!selector?.matches(new LabelSet(spec.template?.metadata?.labels))) {
		throw new Invalid(
			`Deployment.apps "${name}" is invalid: spec.template.metadata.labels: Invalid value: ${formatStringMap(spec.template?.metadata?.labels)}: \`selector\` does not match template \`labels\``,
		);
	}
	if ((spec.replicas ?? 0) < 0) {
		throw new Invalid(
			`Deployment.apps "${name}" is invalid: spec.replicas: Invalid value: ${spec.replicas}: must be greater than or equal to 0`,
		);
	}
	if ((spec.minReadySeconds ?? 0) < 0) {
		throw new Invalid(
			`Deployment.apps "${name}" is invalid: spec.minReadySeconds: Invalid value: ${spec.minReadySeconds}: must be greater than or equal to 0`,
		);
	}
	if (
		spec.progressDeadlineSeconds !== undefined &&
		spec.progressDeadlineSeconds <= (spec.minReadySeconds ?? 0)
	) {
		throw new Invalid(
			`Deployment.apps "${name}" is invalid: spec.progressDeadlineSeconds: Invalid value: ${spec.progressDeadlineSeconds}: must be greater than minReadySeconds`,
		);
	}
}
