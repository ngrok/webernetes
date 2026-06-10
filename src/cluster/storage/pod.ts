import { V1Binding, V1Pod } from "../../client";
import { Invalid, NotFound } from "../../client/errors";
import { Etcd } from "../etcd";
import { Store } from "./store";

export class PodStore extends Store<V1Pod> {
	constructor(etcd: Etcd) {
		super(etcd, {
			apiVersion: "v1",
			defaultQualifiedResource: "pods",
			kind: "Pod",
			singularQualifiedResource: "pod",
			namespaced: true,
		});
	}

	protected async validateCreate(pod: V1Pod): Promise<void> {
		if (!pod.metadata?.name) {
			throw new Error("Pod name is required");
		}

		if (!pod.spec) {
			throw new Error("Pod spec is required");
		}
		// https://github.com/kubernetes/kubernetes/issues/121787
		pod.spec.enableServiceLinks ??= true;
		if (!pod.spec.containers || pod.spec.containers.length === 0) {
			throw new Invalid(`Pod "${pod.metadata.name}" is invalid: spec.containers: Required value`);
		}
		if (pod.spec.dnsPolicy === "None" && !pod.spec.dnsConfig) {
			throw new Invalid(
				`Pod "${pod.metadata.name}" is invalid: spec.dnsConfig: Required value: must provide \`dnsConfig\` when \`dnsPolicy\` is None`,
			);
		}
		if (
			pod.spec.dnsPolicy === "None" &&
			pod.spec.dnsConfig &&
			(!pod.spec.dnsConfig.nameservers || pod.spec.dnsConfig.nameservers.length === 0)
		) {
			throw new Invalid(
				`Pod "${pod.metadata.name}" is invalid: spec.dnsConfig.nameservers: Required value: must provide at least one DNS nameserver when \`dnsPolicy\` is None`,
			);
		}
	}

	protected async validateUpdate(pod: V1Pod, existing: V1Pod): Promise<void> {
		await this.validateCreate(pod);
		if (pod.spec && pod.spec.nodeName === undefined) {
			pod.spec.nodeName = existing.spec?.nodeName;
		}
		if (pod.spec?.nodeName !== existing.spec?.nodeName) {
			throw new Invalid(
				`Pod "${pod.metadata?.name}" is invalid: spec: Forbidden: pod updates may not change fields other than spec.containers[*].image`,
			);
		}
	}

	async bind(name: string, namespace: string, binding: V1Binding): Promise<V1Pod> {
		const pod = await this.get(name, namespace);
		if (!pod) {
			throw new NotFound(`Pod "${name}" not found`);
		}
		if (!binding.target.name) {
			throw new Invalid(`Binding "${name}" is invalid: target.name: Required value`);
		}
		if (pod.spec?.nodeName) {
			throw new Invalid(`Pod "${name}" is invalid: spec.nodeName: Invalid value: already assigned`);
		}

		pod.spec ??= { containers: [] };
		pod.spec.nodeName = binding.target.name;
		return await this.update(name, pod, { skipValidateUpdate: true });
	}
}
