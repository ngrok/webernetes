/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1Container, V1Pod } from "../../../client";
import * as fnv from "../../../fnv";
import type {
	RuntimeFeatures as CRIRuntimeFeatures,
	RuntimeHandler as CRIRuntimeHandler,
	RuntimeStatus as CRIRuntimeStatus,
} from "../../cri/runtime/v1/api";
import {
	RuntimeCondition,
	RuntimeFeatures,
	RuntimeHandler,
	RuntimeStatus,
	type Status,
} from "../container";

// Models kubernetes/pkg/kubelet/kuberuntime/helpers.go GetBackoffKey.
export function getBackoffKey(pod: V1Pod, container: V1Container): string {
	const hash = fnv.new32a();
	hash.write(
		[
			pod.metadata?.name ?? "",
			pod.metadata?.namespace ?? "default",
			pod.metadata?.uid ?? "",
			container.name,
			container.image ?? "",
			container.resources === undefined ? "" : JSON.stringify(container.resources),
		].join("/"),
	);
	return hash.sum32().toString(16);
}

// Models kubernetes/pkg/kubelet/kuberuntime/helpers.go toKubeRuntimeStatus.
export function toKubeRuntimeStatus(
	status: CRIRuntimeStatus,
	handlers: CRIRuntimeHandler[] = [],
	features: CRIRuntimeFeatures | undefined = undefined,
): RuntimeStatus {
	return new RuntimeStatus({
		conditions: status.conditions.map(
			(condition) =>
				new RuntimeCondition({
					type: condition.type,
					status: condition.status,
					reason: condition.reason,
					message: condition.message,
				}),
		),
		handlers: handlers.map(
			(handler) =>
				new RuntimeHandler({
					name: handler.name,
					supportsRecursiveReadOnlyMounts: handler.features?.recursiveReadOnlyMounts ?? false,
					supportsUserNamespaces: handler.features?.userNamespaces ?? false,
				}),
		),
		features:
			features === undefined
				? undefined
				: new RuntimeFeatures({
						supplementalGroupsPolicy: features.supplementalGroupsPolicy,
						userNamespacesHostNetwork: features.userNamespacesHostNetwork,
					}),
	});
}

// Models kubernetes/pkg/kubelet/kuberuntime/helpers.go containerStatusByCreated.
export function containerStatusByCreated(left: Status, right: Status): number {
	return right.createdAt - left.createdAt;
}
