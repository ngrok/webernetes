import { Configuration } from "./gen";

export interface ApiType {}
export type ApiConstructor<T extends ApiType> = new (config: Configuration) => T;

export class KubeConfig {
	public makeApiClient<T extends ApiType>(apiClientType: ApiConstructor<T>): T {
		return new apiClientType(new Configuration());
	}
}
