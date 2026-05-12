import { V1Node } from "../../client";
import { Etcd } from "../etcd";
import { Store } from "./store";

export class NodeStore extends Store<V1Node> {
	public constructor(etcd: Etcd) {
		super(etcd, {
			apiVersion: "v1",
			defaultQualifiedResource: "nodes",
			kind: "Node",
			singularQualifiedResource: "node",
			namespaced: false,
		});
	}

	protected async validateCreate(node: V1Node): Promise<void> {
		if (!node.metadata?.name) {
			throw new Error("Node name is required");
		}
	}
}
