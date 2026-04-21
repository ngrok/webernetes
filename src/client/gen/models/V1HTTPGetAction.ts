import { V1HTTPHeader } from "./V1HTTPHeader";
export interface V1HTTPGetAction {
	host?: string;
	httpHeaders?: Array<V1HTTPHeader>;
	path?: string;
	port: number | string;
	scheme?: string;
}
