import { V1Namespace } from "../../client";
import { Etcd } from "../etcd";
import { Store } from "./store";

export class NamespaceStore extends Store<V1Namespace> {
	public constructor(etcd: Etcd) {
		super(etcd, {
			defaultQualifiedResource: "namespaces",
			singularQualifiedResource: "namespace",
			namespaced: false,
		});
	}

	private validateName(name: string): void {
		if (!name || name.trim().length === 0) {
			throw new Error("Namespace name must be provided");
		}

		if (name.length > 63) {
			throw new Error("Namespace name must be between 1 and 63 characters");
		}

		if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
			throw new Error(
				"Namespace name must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character (e.g. 'my-name',  or '123-abc'",
			);
		}
	}

	protected async validateCreate(namespace: V1Namespace): Promise<void> {
		const name = namespace.metadata?.name ?? "";
		this.validateName(name);
	}
}
