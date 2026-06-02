import { Clock } from "../../clock";
import type { CoreV1Api } from "../../client/gen/apis/types";
import type {
	CoreV1Event,
	V1Container,
	V1ContainerStatus,
	V1Namespace,
	V1Pod,
	V1Service,
	V1Status,
} from "../../client/gen/models";
import { isConflictError } from "../../client/errors";
import type { K8s, KubeConfig, KubernetesObject } from "../../client/types";
import { deepMerge, isPlainObject as isRecord } from "../../deep-merge";
import { retry } from "../../retry";
import { waitFor } from "../wait";
import type { FetchNodePort, NodePortRequest, NodePortResponse } from "./kubernetes";
import type { DeepPartial } from "../../utility-types";

const defaultPodImage = "registry.k8s.io/pause:3.10";
const agnhostImage = "registry.k8s.io/e2e-test-images/agnhost:2.40";

type NamedResource = KubernetesObject & { metadata?: { name?: string; namespace?: string } };
type NameOrResource = string | NamedResource;
export type { DeepPartial };

export interface ExecCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface KubernetesHelpers {
	fetchNodePort(nodePort: number, request?: NodePortRequest): Promise<NodePortResponse>;
	exec(pod: V1Pod, containerName: string, command: string[]): Promise<ExecCommandResult>;
	waitFor(assertion: () => unknown | Promise<unknown>): Promise<void>;
	apply<T extends KubernetesObject>(resources: T[]): Promise<T[]>;
	getSuiteNamespace(): Promise<string>;
	getTestNamespace(): Promise<string>;
	createNamespace(namespace: string | Partial<V1Namespace>): Promise<string>;
	createPod(pod: DeepPartial<V1Pod>): Promise<V1Pod>;
	createAgnhostPod(pod?: DeepPartial<V1Pod>): Promise<V1Pod>;
	createService(service: DeepPartial<V1Service>): Promise<V1Service>;
	createNodePortFor(pods: readonly V1Pod[]): Promise<number>;
	createPodWithNodePort(pod: DeepPartial<V1Pod>): Promise<{
		pod: V1Pod;
		service: V1Service;
		nodePort: number;
	}>;
	replacePod(
		nameOrResource: NameOrResource,
		mutate: (pod: V1Pod) => void,
		namespace?: string,
	): Promise<V1Pod>;
	readPod(nameOrResource: NameOrResource, namespace?: string): Promise<V1Pod>;
	containerStatus(pod: V1Pod, name?: string): V1ContainerStatus;
	waitForPodReady(nameOrResource: NameOrResource, namespace?: string): Promise<V1Pod>;
	eventsFor(resource: KubernetesObject): Promise<CoreV1Event[]>;
	eventReasonsFor(resource: KubernetesObject): Promise<string[]>;
	eventReasonCountFor(resource: KubernetesObject, reason: string): Promise<number>;
}

export interface KubernetesRuntimeHelpers extends KubernetesHelpers {
	disposeTest(): Promise<void>;
	dispose(): Promise<void>;
}

export interface KubernetesHelpersOptions {
	k8s: K8s;
	kubeConfig: KubeConfig;
	core: CoreV1Api;
	fetchNodePort: FetchNodePort;
	apply<T extends KubernetesObject>(resources: T[]): Promise<T[]>;
}

export function createKubernetesHelpers({
	k8s,
	kubeConfig,
	core,
	fetchNodePort: rawFetchNodePort,
	apply,
}: KubernetesHelpersOptions): KubernetesRuntimeHelpers {
	const retryClock = new Clock();
	let suiteNamespace: string | undefined;
	let testNamespace: string | undefined;
	const createNamespace = async (namespace: string | Partial<V1Namespace>): Promise<string> => {
		const body: V1Namespace =
			typeof namespace === "string"
				? {
						metadata: {
							generateName: namespace,
						},
					}
				: {
						...namespace,
						metadata: {
							generateName: "test-",
							...namespace.metadata,
						},
					};
		const resp = await core.createNamespace({ body });
		if (!resp.metadata?.name) {
			throw new Error("Failed to create namespace");
		}
		return resp.metadata.name;
	};
	const getSuiteNamespace = async (): Promise<string> => {
		suiteNamespace ??= await createNamespace("test-");
		return suiteNamespace;
	};
	const getTestNamespace = async (): Promise<string> => {
		testNamespace ??= await createNamespace("test-");
		return testNamespace;
	};
	const eventsFor = async (resource: KubernetesObject): Promise<CoreV1Event[]> => {
		const namespace = resource.metadata?.namespace ?? (await getTestNamespace());
		const events = await core.listNamespacedEvent({ namespace });
		return events.items.filter(
			(event) =>
				event.involvedObject.kind === resource.kind &&
				event.involvedObject.name === resource.metadata?.name,
		);
	};
	const createPod = async (pod: DeepPartial<V1Pod>): Promise<V1Pod> => {
		const podNamespace =
			typeof pod.metadata?.namespace === "string"
				? pod.metadata.namespace
				: await getTestNamespace();
		return await core.createNamespacedPod({
			namespace: podNamespace,
			body: deepMerge<V1Pod>(
				{
					metadata: {
						name: "test-pod",
					},
					spec: {
						containers: [{ name: "test", image: defaultPodImage }],
					},
				},
				pod,
			),
		});
	};
	const createAgnhostPod = async (pod: DeepPartial<V1Pod> = {}): Promise<V1Pod> => {
		return await createPod(
			deepMerge<DeepPartial<V1Pod>>(
				{
					spec: {
						containers: [agnhostContainer()],
					},
				},
				pod,
			),
		);
	};
	const createService = async (service: DeepPartial<V1Service>): Promise<V1Service> => {
		const serviceNamespace =
			typeof service.metadata?.namespace === "string"
				? service.metadata.namespace
				: await getTestNamespace();
		return await core.createNamespacedService({
			namespace: serviceNamespace,
			body: deepMerge<V1Service>(
				{
					metadata: {
						name: "test-service",
					},
					spec: {
						ports: [{ port: 80 }],
					},
				},
				service,
			),
		});
	};
	const waitForPodReady = async (
		nameOrResource: NameOrResource,
		namespace?: string,
	): Promise<V1Pod> => {
		let pod = await readPodResource(core, nameOrResource, getTestNamespace, namespace);
		await retry(
			async () => {
				pod = await readPodResource(core, pod, getTestNamespace);
				if (pod.status?.phase !== "Running") {
					throw new Error(`Expected pod ${pod.metadata?.name ?? ""} to be Running`);
				}
				if (!containerReady(pod)) {
					throw new Error(`Expected pod ${pod.metadata?.name ?? ""} to have a ready container`);
				}
			},
			{
				clock: retryClock,
				retries: 50,
				baseDelayMs: 100,
				maxDelayMs: 100,
				jitterRatio: 0,
			},
		);
		return pod;
	};

	return {
		async fetchNodePort(
			nodePort: number,
			request: NodePortRequest = {},
		): Promise<NodePortResponse> {
			const { expectedCode = 200, retries = 10, ...nodePortRequest } = request;
			return await retry(
				async () => {
					const response = await rawFetchNodePort(nodePort, nodePortRequest);
					if (response.status !== expectedCode) {
						throw new Error(
							`Expected NodePort ${nodePort} to return HTTP ${expectedCode}, got ${response.status}`,
						);
					}
					return response;
				},
				{
					clock: retryClock,
					retries,
					baseDelayMs: 50,
					maxDelayMs: 1000,
				},
			);
		},
		async exec(pod: V1Pod, containerName: string, command: string[]): Promise<ExecCommandResult> {
			const namespace = pod.metadata?.namespace;
			const podName = pod.metadata?.name;
			if (!namespace || !podName) {
				throw new Error("Expected pod to have metadata.namespace and metadata.name");
			}
			const stdout = new TextWritable();
			const stderr = new TextWritable();
			const status = await new Promise<V1Status>((resolve, reject) => {
				new k8s.Exec(kubeConfig)
					.exec(namespace, podName, containerName, command, stdout, stderr, null, false, resolve)
					.catch(reject);
			});
			return {
				stdout: stdout.text,
				stderr: stderr.text,
				exitCode:
					status.status === "Success" ? 0 : Number(status.details?.causes?.[0]?.message ?? 1),
			};
		},
		waitFor,
		apply,
		getSuiteNamespace,
		getTestNamespace,
		createNamespace,
		createPod,
		createAgnhostPod,
		createService,
		async createNodePortFor(pods: readonly V1Pod[]): Promise<number> {
			return (await createNodePortForPods(core, pods)).nodePort;
		},
		async createPodWithNodePort(pod: DeepPartial<V1Pod>): Promise<{
			pod: V1Pod;
			service: V1Service;
			nodePort: number;
		}> {
			let created = await createPod(pod);
			servicePortForSingleExposedContainer(created);
			const { service, nodePort } = await createNodePortForPods(core, [created]);
			created = await waitForPodReady(created);
			return { pod: created, service, nodePort };
		},
		async replacePod(
			nameOrResource: NameOrResource,
			mutate: (pod: V1Pod) => void,
			namespace?: string,
		): Promise<V1Pod> {
			const { name, namespace: podNamespace } = await nameAndNamespace(
				nameOrResource,
				namespace,
				getTestNamespace,
			);
			return await retry(
				async () => {
					const current = await core.readNamespacedPod({ name, namespace: podNamespace });
					mutate(current);
					return await core.replaceNamespacedPod({
						name,
						namespace: podNamespace,
						body: current,
					});
				},
				{
					clock: retryClock,
					retries: 4,
					baseDelayMs: 10,
					maxDelayMs: 250,
					jitterRatio: 0.2,
					shouldRetry: (error) => isConflictError(error) || isPodSchedulerBindRace(error),
				},
			);
		},
		async readPod(nameOrResource: NameOrResource, namespace?: string): Promise<V1Pod> {
			return await readPodResource(core, nameOrResource, getTestNamespace, namespace);
		},
		containerStatus,
		waitForPodReady,
		eventsFor,
		async eventReasonsFor(resource: KubernetesObject): Promise<string[]> {
			return (await eventsFor(resource))
				.map((event) => event.reason)
				.filter((reason) => reason !== undefined);
		},
		async eventReasonCountFor(resource: KubernetesObject, reason: string): Promise<number> {
			return (await eventsFor(resource))
				.filter((event) => event.reason === reason)
				.reduce((total, event) => total + (event.count ?? 1), 0);
		},
		async disposeTest(): Promise<void> {
			if (testNamespace) {
				await core.deleteNamespace({ name: testNamespace });
			}
			testNamespace = undefined;
		},
		async dispose(): Promise<void> {
			await this.disposeTest();
			if (suiteNamespace) {
				await core.deleteNamespace({ name: suiteNamespace });
			}
			suiteNamespace = undefined;
		},
	};
}

function isPodSchedulerBindRace(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes("HTTP-Code: 422") &&
		error.message.includes("NodeName")
	);
}

function agnhostContainer(): V1Container {
	return {
		name: "server",
		image: agnhostImage,
		command: ["/agnhost", "netexec", "--http-port=8080"],
		ports: [{ name: "http", containerPort: 8080 }],
	};
}

function containerStatus(pod: V1Pod, name = "test"): V1ContainerStatus {
	const status = pod.status?.containerStatuses?.find((container) => container.name === name);
	if (!status) {
		throw new Error(`Expected pod ${pod.metadata?.name ?? ""} to have container status ${name}`);
	}
	return status;
}

class TextWritable {
	text = "";

	write(chunk: unknown): void {
		if (typeof chunk === "string") {
			this.text += chunk;
			return;
		}
		if (chunk instanceof Uint8Array) {
			this.text += new TextDecoder().decode(chunk);
			return;
		}
		this.text += String(chunk);
	}

	end(): void {}
}

function sharedPodSelector(pods: readonly V1Pod[]): {
	namespace: string;
	selector: { [key: string]: string };
} {
	if (pods.length === 0) {
		throw new Error("Expected at least one pod");
	}

	const firstPod = pods[0];
	const namespace = firstPod.metadata?.namespace;
	if (!namespace) {
		throw new Error(`Expected pod ${firstPod.metadata?.name ?? ""} to have metadata.namespace`);
	}

	for (const pod of pods) {
		if (!pod.metadata?.name) {
			throw new Error("Expected every pod to have metadata.name");
		}
		if (pod.metadata.namespace !== namespace) {
			throw new Error("Expected all pods to be in the same namespace");
		}
	}

	const firstLabels = firstPod.metadata?.labels ?? {};
	for (const [key, value] of Object.entries(firstLabels)) {
		if (pods.every((pod) => pod.metadata?.labels?.[key] === value)) {
			return {
				namespace,
				selector: { [key]: value },
			};
		}
	}

	throw new Error("Expected pods to share at least one label");
}

async function createNodePortForPods(
	core: CoreV1Api,
	pods: readonly V1Pod[],
): Promise<{ service: V1Service; nodePort: number }> {
	const { namespace, selector } = sharedPodSelector(pods);
	const servicePort = servicePortForSingleExposedContainer(pods[0]);
	const firstPodName = pods[0]?.metadata?.name ?? "pod";
	const service = await core.createNamespacedService({
		namespace,
		body: {
			metadata: {
				generateName: `${firstPodName}-nodeport-`,
			},
			spec: {
				type: "NodePort",
				selector,
				ports: [servicePort],
			},
		},
	});
	const nodePort = service.spec?.ports?.[0]?.nodePort;
	if (nodePort === undefined) {
		throw new Error("Expected Service to allocate a NodePort");
	}
	return { service, nodePort };
}

function servicePortForSingleExposedContainer(pod: V1Pod): {
	name?: string;
	port: number;
	targetPort: number | string;
} {
	const containersWithPorts = (pod.spec?.containers ?? []).filter(
		(container) => (container.ports ?? []).length > 0,
	);
	if (containersWithPorts.length === 0) {
		throw new Error(`Expected pod ${pod.metadata?.name ?? ""} to expose a container port`);
	}
	if (containersWithPorts.length > 1) {
		throw new Error(
			`Expected pod ${pod.metadata?.name ?? ""} to have only one container with exposed ports`,
		);
	}

	const container = containersWithPorts[0];
	const port = container.ports?.[0];
	if (!port) {
		throw new Error(`Expected pod ${pod.metadata?.name ?? ""} to expose a container port`);
	}
	return {
		name: port.name,
		port: port.containerPort,
		targetPort: port.name ?? port.containerPort,
	};
}

function containerReady(pod: V1Pod): boolean {
	return pod.status?.containerStatuses?.some((status) => status.ready) ?? false;
}

async function readPodResource(
	core: CoreV1Api,
	nameOrResource: NameOrResource,
	defaultNamespace: () => Promise<string>,
	namespace?: string,
): Promise<V1Pod> {
	const pod = await nameAndNamespace(nameOrResource, namespace, defaultNamespace);
	return await core.readNamespacedPod({
		name: pod.name,
		namespace: pod.namespace,
	});
}

async function nameAndNamespace(
	nameOrResource: NameOrResource,
	namespace: string | undefined,
	defaultNamespace: () => Promise<string>,
): Promise<{ name: string; namespace: string }> {
	if (typeof nameOrResource === "string") {
		return {
			name: nameOrResource,
			namespace: namespace ?? (await defaultNamespace()),
		};
	}

	const name = nameOrResource.metadata?.name;
	if (!name) {
		throw new Error("Expected resource metadata.name");
	}
	return {
		name,
		namespace: namespace ?? nameOrResource.metadata?.namespace ?? (await defaultNamespace()),
	};
}

export function apiErrorCode(error: unknown): number | undefined {
	if (!isRecord(error)) {
		return undefined;
	}
	return typeof error.code === "number" ? error.code : undefined;
}

export function apiStatusMessage(error: unknown): string | undefined {
	if (!isRecord(error)) {
		return undefined;
	}
	const body = error.body;
	if (typeof body === "string") {
		return apiStatusMessageFromBody(parseJson(body));
	}
	return apiStatusMessageFromBody(body);
}

function apiStatusMessageFromBody(body: unknown): string | undefined {
	if (!isRecord(body)) {
		return undefined;
	}
	return typeof body.message === "string" ? body.message : undefined;
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}
