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
		if (!pod.spec.containers || pod.spec.containers.length === 0) {
			throw new Invalid(`Pod "${pod.metadata.name}" is invalid: spec.containers: Required value`);
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
