import { ListWatch, type ObjectCache } from "./cache";
import { KubeConfig } from "./config";
import type { KubeList, KubernetesObject } from "./types";
import { Watch } from "./watch";

export type ObjectCallback<T extends KubernetesObject> = (obj: T) => void;
export type ErrorCallback = (err?: unknown) => void;
export type ListCallback<T extends KubernetesObject> = (list: T[], resourceVersion: string) => void;
export type ListPromise<T extends KubernetesObject> = () => Promise<KubeList<T>>;

export const ADD = "add";
export type ADD = typeof ADD;

export const UPDATE = "update";
export type UPDATE = typeof UPDATE;

export const CHANGE = "change";
export type CHANGE = typeof CHANGE;

export const DELETE = "delete";
export type DELETE = typeof DELETE;

export const CONNECT = "connect";
export type CONNECT = typeof CONNECT;

export const ERROR = "error";
export type ERROR = typeof ERROR;

export interface Informer<T extends KubernetesObject> {
	on(verb: ADD | UPDATE | DELETE | CHANGE, cb: ObjectCallback<T>): void;
	on(verb: ERROR | CONNECT, cb: ErrorCallback): void;
	off(verb: ADD | UPDATE | DELETE | CHANGE, cb: ObjectCallback<T>): void;
	off(verb: ERROR | CONNECT, cb: ErrorCallback): void;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export function makeInformer<T extends KubernetesObject>(
	kubeconfig: KubeConfig,
	path: string,
	listPromiseFn: ListPromise<T>,
	labelSelector?: string,
	// Intentional local extension: upstream makeInformer does not expose fieldSelector.
	fieldSelector?: string,
): Informer<T> & ObjectCache<T> {
	const watch = new Watch(kubeconfig);
	return new ListWatch(path, watch, listPromiseFn, false, labelSelector, fieldSelector);
}
