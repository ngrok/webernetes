import type { Etcd } from "../../etcd";
import type { Node } from "../../types/core/v1/types";
import { Store } from "./storage";

export class NodeStore extends Store<Node> {
	constructor(etcd: Etcd) {
		super(etcd, {
			defaultQualifiedResource: "nodes",
			singularQualifiedResource: "node",
			namespaced: false,
		});
	}
}
