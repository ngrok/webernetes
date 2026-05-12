import { V1ListMeta } from "./V1ListMeta";
import { V1Namespace } from "./V1Namespace";

export interface V1NamespaceList {
	apiVersion?: string;
	items: Array<V1Namespace>;
	kind?: string;
	metadata?: V1ListMeta;
}
