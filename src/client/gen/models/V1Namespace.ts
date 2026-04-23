import { V1NamespaceSpec } from "./V1NamespaceSpec";
import { V1NamespaceStatus } from "./V1NamespaceStatus";
import { V1ObjectMeta } from "./V1ObjectMeta";

export interface V1Namespace {
	apiVersion?: string;
	kind?: string;
	metadata?: V1ObjectMeta;
	spec?: V1NamespaceSpec;
	status?: V1NamespaceStatus;
}
