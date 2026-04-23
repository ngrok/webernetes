import { V1NamespaceCondition } from "./V1NamespaceCondition";

export interface V1NamespaceStatus {
	conditions?: Array<V1NamespaceCondition>;
	phase?: string;
}
