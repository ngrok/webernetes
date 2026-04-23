import { V1ListMeta } from "./V1ListMeta";
import { V1Pod } from "./V1Pod";

export interface V1PodList {
	apiVersion?: string;
	items: Array<V1Pod>;
	kind?: string;
	metadata?: V1ListMeta;
}
