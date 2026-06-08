import { V1NodeConfigSource } from "./V1NodeConfigSource";

export interface V1NodeConfigStatus {
	active?: V1NodeConfigSource;
	assigned?: V1NodeConfigSource;
	error?: string;
	lastKnownGood?: V1NodeConfigSource;
}
