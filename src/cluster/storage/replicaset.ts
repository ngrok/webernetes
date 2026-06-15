/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1ReplicaSet } from "../../client";
import { labelSelectorAsSelector } from "../../apimachinery/pkg/apis/meta/v1/helpers";
import { Set as LabelSet } from "../../apimachinery/pkg/labels/labels";
import { Invalid } from "../../client/errors";
import { Etcd } from "../etcd";
import { formatLabelSelector, formatStringMap } from "./helpers";
import { Store } from "./store";

// Models kubernetes/pkg/apis/apps/v1/defaults.go SetDefaults_ReplicaSet.
export class ReplicaSetStore extends Store<V1ReplicaSet> {
	constructor(etcd: Etcd) {
		super(etcd, {
			apiVersion: "apps/v1",
			defaultQualifiedResource: "replicasets",
			kind: "ReplicaSet",
			singularQualifiedResource: "replicaset.apps",
			namespaced: true,
		});
	}

	protected override async prepareCreate(replicaSet: V1ReplicaSet): Promise<void> {
		replicaSet.spec ??= {
			selector: {},
		};
		replicaSet.spec.replicas ??= 1;
		replicaSet.status ??= { replicas: 0 };
		replicaSet.status.replicas ??= 0;
	}

	protected override async prepareUpdate(
		replicaSet: V1ReplicaSet,
		existing: V1ReplicaSet,
	): Promise<void> {
		replicaSet.spec ??= {
			selector: existing.spec?.selector ?? {},
		};
		replicaSet.spec.replicas ??= existing.spec?.replicas ?? 1;
		replicaSet.status ??= existing.status ?? { replicas: 0 };
		replicaSet.status.replicas ??= 0;
	}

	protected override async validateCreate(replicaSet: V1ReplicaSet): Promise<void> {
		validateReplicaSet(replicaSet);
	}

	protected override async validateUpdate(
		replicaSet: V1ReplicaSet,
		existing: V1ReplicaSet,
	): Promise<void> {
		validateReplicaSet(replicaSet);
		if (JSON.stringify(replicaSet.spec?.selector) !== JSON.stringify(existing.spec?.selector)) {
			throw new Invalid(
				`ReplicaSet.apps "${replicaSet.metadata?.name}" is invalid: spec.selector: Invalid value: ${formatLabelSelector(replicaSet.spec?.selector)}: field is immutable`,
			);
		}
	}
}

// Models kubernetes/pkg/apis/apps/validation/validation.go ValidateReplicaSetSpec.
function validateReplicaSet(replicaSet: V1ReplicaSet): void {
	const name = replicaSet.metadata?.name ?? "";
	const spec = replicaSet.spec;
	if (!spec) {
		throw new Invalid(`ReplicaSet.apps "${name}" is invalid: spec: Required value`);
	}
	const [selector, selectorErr] = labelSelectorAsSelector(spec.selector);
	if (!spec.selector || selector?.empty()) {
		throw new Invalid(`ReplicaSet.apps "${name}" is invalid: spec.selector: Required value`);
	}
	if (selectorErr) {
		throw new Invalid(
			`ReplicaSet.apps "${name}" is invalid: spec.selector: Invalid value: ${formatLabelSelector(spec.selector)}: ${selectorErr.message}`,
		);
	}
	if (!selector?.matches(new LabelSet(spec.template?.metadata?.labels))) {
		throw new Invalid(
			`ReplicaSet.apps "${name}" is invalid: spec.template.metadata.labels: Invalid value: ${formatStringMap(spec.template?.metadata?.labels)}: \`selector\` does not match template \`labels\``,
		);
	}
	if ((spec.replicas ?? 0) < 0) {
		throw new Invalid(
			`ReplicaSet.apps "${name}" is invalid: spec.replicas: Invalid value: ${spec.replicas}: must be greater than or equal to 0`,
		);
	}
	if ((spec.minReadySeconds ?? 0) < 0) {
		throw new Invalid(
			`ReplicaSet.apps "${name}" is invalid: spec.minReadySeconds: Invalid value: ${spec.minReadySeconds}: must be greater than or equal to 0`,
		);
	}
}
