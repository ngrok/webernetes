import { IconButton } from "@ngrok/mantle/button";
import { Card } from "@ngrok/mantle/card";
import {
	CodeBlock,
	createMantleCodeBlockValue,
	decorateHighlightedHtml,
	type MantleCodeBlockValue,
} from "@ngrok/mantle/code-block";
import { Popover } from "@ngrok/mantle/popover";
import { RadioGroup } from "@ngrok/mantle/radio-group";
import { Table } from "@ngrok/mantle/table";
import { Tabs } from "@ngrok/mantle/tabs";
import { useAppliedTheme } from "@ngrok/mantle/theme";
import { Tooltip } from "@ngrok/mantle/tooltip";
import { EyeIcon, MinusIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { ComponentProps, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { codeToHtml } from "shiki";
import * as w8s from "webernetes";
import { stringify as stringifyYaml } from "yaml";

import {
	getName,
	getNamespace,
	getReadyContainers,
	getRestartCount,
	demoControlPort,
	fetchPodPort,
	idFor,
	podDisplayPhase,
	podIdsForLabelSelector,
	podIdsForService,
	sortByName,
} from "../helpers";
import { useInformer } from "../hooks";

type ResourceTab =
	| "pods"
	| "deployments"
	| "replicasets"
	| "services"
	| "nodes"
	| "namespaces"
	| "events";
type HealthValue = "healthy" | "unhealthy";
type PodHealthKind = "ready" | "live";
type PodHealthSelection = {
	generation: string;
	live?: HealthValue;
	ready?: HealthValue;
};

export function ResourcesTabs({
	cluster,
	namespace,
	onHighlightedPodIdsChange,
}: {
	cluster: w8s.Cluster;
	namespace: string | undefined;
	onHighlightedPodIdsChange: (podIds: Set<string>) => void;
}) {
	const [tab, setTab] = useState<ResourceTab>("pods");
	const namespaces = useInformer({
		cluster,
		resource: "namespaces",
		sort: sortByName,
	});

	const pods = useInformer({
		cluster,
		namespace,
		resource: "pods",
		sort: sortByName,
	});
	const deployments = useInformer({
		cluster,
		namespace,
		resource: "deployments",
		sort: sortByName,
	});
	const replicasets = useInformer({
		cluster,
		namespace,
		resource: "replicasets",
		sort: sortByName,
	});
	const services = useInformer({
		cluster,
		namespace,
		resource: "services",
		sort: sortByName,
	});
	const nodes = useInformer({
		cluster,
		resource: "nodes",
		sort: sortByName,
	});
	const events = useInformer({
		cluster,
		limit: 50,
		namespace,
		resource: "events",
		sort: sortEventsByTimestampDescending,
	});

	const counts = useMemo(
		() => ({
			pods: pods.length,
			deployments: deployments.length,
			replicasets: replicasets.length,
			services: services.length,
			nodes: nodes.length,
			namespaces: namespaces.length,
			events: events.length,
		}),
		[
			deployments.length,
			events.length,
			namespaces.length,
			nodes.length,
			pods.length,
			replicasets.length,
			services.length,
		],
	);

	return (
		<Card.Root>
			<Tabs.Root
				appearance="pill"
				value={tab}
				onValueChange={(value) => {
					setTab(value as ResourceTab);
					onHighlightedPodIdsChange(new Set());
				}}
			>
				<Card.Body>
					<Tabs.List className="mb-4 flex flex-wrap gap-2">
						<Tabs.Trigger value="pods">
							Pods
							<Tabs.Badge>{counts.pods}</Tabs.Badge>
						</Tabs.Trigger>
						<Tabs.Trigger value="deployments">
							Deployments
							<Tabs.Badge>{counts.deployments}</Tabs.Badge>
						</Tabs.Trigger>
						<Tabs.Trigger value="replicasets">
							ReplicaSets
							<Tabs.Badge>{counts.replicasets}</Tabs.Badge>
						</Tabs.Trigger>
						<Tabs.Trigger value="services">
							Services
							<Tabs.Badge>{counts.services}</Tabs.Badge>
						</Tabs.Trigger>
						<Tabs.Trigger value="nodes">
							Nodes
							<Tabs.Badge>{counts.nodes}</Tabs.Badge>
						</Tabs.Trigger>
						<Tabs.Trigger value="namespaces">
							Namespaces
							<Tabs.Badge>{counts.namespaces}</Tabs.Badge>
						</Tabs.Trigger>
						<Tabs.Trigger value="events">
							Events
							<Tabs.Badge>{counts.events}</Tabs.Badge>
						</Tabs.Trigger>
					</Tabs.List>

					<Tabs.Content value="pods">
						<Pods
							cluster={cluster}
							onHighlightedPodIdsChange={onHighlightedPodIdsChange}
							pods={pods}
						/>
					</Tabs.Content>
					<Tabs.Content value="deployments">
						<Deployments
							cluster={cluster}
							deployments={deployments}
							onHighlightedPodIdsChange={onHighlightedPodIdsChange}
							pods={pods}
						/>
					</Tabs.Content>
					<Tabs.Content value="replicasets">
						<ReplicaSets
							onHighlightedPodIdsChange={onHighlightedPodIdsChange}
							pods={pods}
							replicasets={replicasets}
						/>
					</Tabs.Content>
					<Tabs.Content value="services">
						<Services
							onHighlightedPodIdsChange={onHighlightedPodIdsChange}
							pods={pods}
							services={services}
						/>
					</Tabs.Content>
					<Tabs.Content value="nodes">
						<Nodes nodes={nodes} />
					</Tabs.Content>
					<Tabs.Content value="namespaces">
						<Namespaces namespaces={namespaces} />
					</Tabs.Content>
					<Tabs.Content value="events">
						<Events events={events} />
					</Tabs.Content>
				</Card.Body>
			</Tabs.Root>
		</Card.Root>
	);
}

function Deployments({
	cluster,
	deployments,
	onHighlightedPodIdsChange,
	pods,
}: {
	cluster: w8s.Cluster;
	deployments: w8s.V1Deployment[];
	onHighlightedPodIdsChange: (podIds: Set<string>) => void;
	pods: w8s.V1Pod[];
}) {
	return (
		<ResourceTable count={deployments.length} emptyLabel="No deployments match this namespace.">
			<Table.Head>
				<Table.Row>
					<Table.Header>Name</Table.Header>
					<Table.Header>Namespace</Table.Header>
					<Table.Header>Desired</Table.Header>
					<Table.Header>Ready</Table.Header>
					<Table.Header>Available</Table.Header>
					<Table.Header>Updated</Table.Header>
					<Table.Header>Selector</Table.Header>
					<Table.Header>Actions</Table.Header>
				</Table.Row>
			</Table.Head>
			<Table.Body>
				{deployments.map((deployment) => {
					const replicas = deployment.spec?.replicas ?? 1;
					return (
						<Table.Row
							key={idFor(deployment)}
							onPointerEnter={() =>
								onHighlightedPodIdsChange(
									podIdsForLabelSelector(deployment.spec?.selector, getNamespace(deployment), pods),
								)
							}
							onPointerLeave={() => onHighlightedPodIdsChange(new Set())}
						>
							<Table.Cell>{getName(deployment, "-")}</Table.Cell>
							<Table.Cell>{getNamespace(deployment) ?? "default"}</Table.Cell>
							<Table.Cell>{replicas}</Table.Cell>
							<Table.Cell>{deployment.status?.readyReplicas ?? 0}</Table.Cell>
							<Table.Cell>{deployment.status?.availableReplicas ?? 0}</Table.Cell>
							<Table.Cell>{deployment.status?.updatedReplicas ?? 0}</Table.Cell>
							<Table.Cell>{formatLabelSelector(deployment.spec?.selector)}</Table.Cell>
							<Table.Cell>
								<div className="flex items-center gap-2">
									<RowActionIconButton
										type="button"
										appearance="outlined"
										size="md"
										disabled={replicas === 0}
										label="Remove replica"
										icon={<MinusIcon aria-hidden />}
										onClick={() => void scaleDeployment(cluster, deployment, -1)}
									/>
									<RowActionIconButton
										type="button"
										appearance="outlined"
										size="md"
										label="Add replica"
										icon={<PlusIcon aria-hidden />}
										onClick={() => void scaleDeployment(cluster, deployment, 1)}
									/>
									<ResourceYamlPopover resource={deployment} />
								</div>
							</Table.Cell>
						</Table.Row>
					);
				})}
			</Table.Body>
		</ResourceTable>
	);
}

function ReplicaSets({
	onHighlightedPodIdsChange,
	pods,
	replicasets,
}: {
	onHighlightedPodIdsChange: (podIds: Set<string>) => void;
	pods: w8s.V1Pod[];
	replicasets: w8s.V1ReplicaSet[];
}) {
	return (
		<ResourceTable count={replicasets.length} emptyLabel="No replica sets match this namespace.">
			<Table.Head>
				<Table.Row>
					<Table.Header>Name</Table.Header>
					<Table.Header>Namespace</Table.Header>
					<Table.Header>Desired</Table.Header>
					<Table.Header>Current</Table.Header>
					<Table.Header>Ready</Table.Header>
					<Table.Header>Available</Table.Header>
					<Table.Header>Selector</Table.Header>
					<Table.Header>Actions</Table.Header>
				</Table.Row>
			</Table.Head>
			<Table.Body>
				{replicasets.map((replicaset) => (
					<Table.Row
						key={idFor(replicaset)}
						onPointerEnter={() =>
							onHighlightedPodIdsChange(
								podIdsForLabelSelector(replicaset.spec?.selector, getNamespace(replicaset), pods),
							)
						}
						onPointerLeave={() => onHighlightedPodIdsChange(new Set())}
					>
						<Table.Cell>{getName(replicaset, "-")}</Table.Cell>
						<Table.Cell>{getNamespace(replicaset) ?? "default"}</Table.Cell>
						<Table.Cell>{replicaset.spec?.replicas ?? 1}</Table.Cell>
						<Table.Cell>{replicaset.status?.replicas ?? 0}</Table.Cell>
						<Table.Cell>{replicaset.status?.readyReplicas ?? 0}</Table.Cell>
						<Table.Cell>{replicaset.status?.availableReplicas ?? 0}</Table.Cell>
						<Table.Cell>{formatLabelSelector(replicaset.spec?.selector)}</Table.Cell>
						<Table.Cell>
							<ResourceYamlPopover resource={replicaset} />
						</Table.Cell>
					</Table.Row>
				))}
			</Table.Body>
		</ResourceTable>
	);
}

async function scaleDeployment(
	cluster: w8s.Cluster,
	deployment: w8s.V1Deployment,
	delta: -1 | 1,
): Promise<void> {
	const name = getName(deployment);
	const namespace = getNamespace(deployment);
	const replicas = Math.max(0, (deployment.spec?.replicas ?? 1) + delta);
	if (!name) {
		return;
	}
	try {
		await cluster.api.appsv1.replaceNamespacedDeploymentScale({
			name,
			namespace,
			body: {
				metadata: {
					name,
					namespace,
				},
				spec: {
					replicas,
				},
			},
		});
	} catch (error) {
		console.error(`failed to scale deployment ${namespace}/${name}`, error);
	}
}

function Pods({
	cluster,
	onHighlightedPodIdsChange,
	pods,
}: {
	cluster: w8s.Cluster;
	onHighlightedPodIdsChange: (podIds: Set<string>) => void;
	pods: w8s.V1Pod[];
}) {
	const [healthSelections, setHealthSelections] = useState<Record<string, PodHealthSelection>>({});

	async function setPodHealthSelection(pod: w8s.V1Pod, kind: PodHealthKind, value: HealthValue) {
		const podId = idFor(pod);
		const generation = podHealthGeneration(pod);
		setHealthSelections((current) => ({
			...current,
			[podId]: {
				...(current[podId]?.generation === generation ? current[podId] : { generation }),
				generation,
				[kind]: value,
			},
		}));
		await setPodHealth(cluster, pod, kind, value);
	}

	return (
		<ResourceTable count={pods.length} emptyLabel="No pods match this namespace.">
			<Table.Head>
				<Table.Row>
					<Table.Header>Name</Table.Header>
					<Table.Header>Namespace</Table.Header>
					<Table.Header>Phase</Table.Header>
					<Table.Header>Node</Table.Header>
					<Table.Header>Containers</Table.Header>
					<Table.Header>Restarts</Table.Header>
					<Table.Header>Ready</Table.Header>
					<Table.Header>Live</Table.Header>
					<Table.Header>Actions</Table.Header>
				</Table.Row>
			</Table.Head>
			<Table.Body>
				{pods.map((pod) => {
					const name = getName(pod);
					const generation = podHealthGeneration(pod);
					const selection = healthSelections[idFor(pod)];
					const readyValue =
						selection?.generation === generation && selection.ready
							? selection.ready
							: podReadyValue(pod);
					const liveValue =
						selection?.generation === generation && selection.live ? selection.live : "healthy";
					const controlsDisabled = pod.status?.podIP === undefined;
					return (
						<Table.Row
							key={idFor(pod)}
							onPointerEnter={() => onHighlightedPodIdsChange(new Set([idFor(pod)]))}
							onPointerLeave={() => onHighlightedPodIdsChange(new Set())}
						>
							<Table.Cell>{getName(pod, "-")}</Table.Cell>
							<Table.Cell>{getNamespace(pod) ?? "default"}</Table.Cell>
							<Table.Cell>{podDisplayPhase(pod)}</Table.Cell>
							<Table.Cell>{pod.spec?.nodeName ?? "unscheduled"}</Table.Cell>
							<Table.Cell>
								{getReadyContainers(pod)}/{pod.spec?.containers?.length ?? 0}
							</Table.Cell>
							<Table.Cell>{getRestartCount(pod)}</Table.Cell>
							<Table.Cell>
								<HealthControl
									disabled={controlsDisabled}
									kind="ready"
									label={`Readiness for ${name || "pod"}`}
									tooltip="Readiness controls whether this pod receives service traffic."
									value={readyValue}
									healthyLabel="Make this pod pass its readiness check"
									unhealthyLabel="Make this pod fail its readiness check"
									onChange={(value) => setPodHealthSelection(pod, "ready", value)}
								/>
							</Table.Cell>
							<Table.Cell>
								<HealthControl
									disabled={controlsDisabled}
									kind="live"
									label={`Liveness for ${name || "pod"}`}
									tooltip="Liveness failure makes the kubelet restart this container."
									value={liveValue}
									healthyLabel="Make this pod pass its liveness check"
									unhealthyLabel="Make this pod fail its liveness check"
									onChange={(value) => setPodHealthSelection(pod, "live", value)}
								/>
							</Table.Cell>
							<Table.Cell>
								<div className="flex items-center gap-2">
									<RowActionIconButton
										type="button"
										appearance="outlined"
										size="md"
										className="border-danger-600 text-danger-600 focus-visible:ring-focus-danger not-disabled:hover:border-danger-700 not-disabled:hover:bg-danger-500/10 not-disabled:hover:text-danger-700"
										label="Delete pod"
										icon={<TrashIcon aria-hidden />}
										disabled={!name}
										onClick={() => void terminatePod(cluster, pod)}
									/>
									<ResourceYamlPopover resource={pod} />
								</div>
							</Table.Cell>
						</Table.Row>
					);
				})}
			</Table.Body>
		</ResourceTable>
	);
}

function HealthControl({
	disabled,
	healthyLabel,
	kind,
	label,
	onChange,
	tooltip,
	unhealthyLabel,
	value,
}: {
	disabled: boolean;
	healthyLabel: string;
	kind: PodHealthKind;
	label: string;
	onChange: (value: HealthValue) => void;
	tooltip: string;
	unhealthyLabel: string;
	value: HealthValue;
}) {
	const buttonClassName = healthControlButtonClassName(kind);
	return (
		<Tooltip.Root>
			<Tooltip.Trigger asChild>
				<RadioGroup.ButtonGroup
					aria-label={label}
					className="w-fit"
					disabled={disabled}
					value={value}
					onChange={(nextValue) => onChange(nextValue as HealthValue)}
				>
					<RadioGroup.Button
						value="healthy"
						aria-label={healthyLabel}
						title={healthyLabel}
						className={buttonClassName}
					>
						<span aria-hidden>✓</span>
					</RadioGroup.Button>
					<RadioGroup.Button
						value="unhealthy"
						aria-label={unhealthyLabel}
						title={unhealthyLabel}
						className={buttonClassName}
					>
						<span aria-hidden>✕</span>
					</RadioGroup.Button>
				</RadioGroup.ButtonGroup>
			</Tooltip.Trigger>
			<Tooltip.Content className="max-w-72">{tooltip}</Tooltip.Content>
		</Tooltip.Root>
	);
}

function healthControlButtonClassName(kind: PodHealthKind): string {
	switch (kind) {
		case "ready":
			return "text-blue-700 not-aria-disabled:hover:border-blue-500 aria-checked:border-blue-500/70 aria-checked:bg-blue-500/20 aria-checked:text-blue-900 dark:text-blue-700 dark:aria-checked:bg-blue-500/25 dark:aria-checked:text-blue-900";
		case "live":
			return "text-fuchsia-700 not-aria-disabled:hover:border-fuchsia-500 aria-checked:border-fuchsia-500/70 aria-checked:bg-fuchsia-500/20 aria-checked:text-fuchsia-900 dark:text-fuchsia-700 dark:aria-checked:bg-fuchsia-500/25 dark:aria-checked:text-fuchsia-900";
	}
}

async function setPodHealth(
	cluster: w8s.Cluster,
	pod: w8s.V1Pod,
	kind: PodHealthKind,
	value: HealthValue,
): Promise<void> {
	const path =
		kind === "ready"
			? value === "healthy"
				? "/ready"
				: "/not-ready"
			: value === "healthy"
				? "/live"
				: "/not-live";
	await fetchPodPort(cluster, pod, demoControlPort, path, { method: "POST" });
}

function podReadyValue(pod: w8s.V1Pod): HealthValue {
	const containers = pod.spec?.containers?.length ?? 0;
	return containers > 0 && getReadyContainers(pod) === containers ? "healthy" : "unhealthy";
}

function podHealthGeneration(pod: w8s.V1Pod): string {
	return (pod.status?.containerStatuses ?? [])
		.map((status) => `${status.name}:${status.containerID ?? ""}:${status.restartCount}`)
		.join("|");
}

async function terminatePod(cluster: w8s.Cluster, pod: w8s.V1Pod): Promise<void> {
	const name = getName(pod);
	const namespace = getNamespace(pod);
	if (!name) {
		return;
	}
	try {
		await cluster.api.corev1.deleteNamespacedPod({
			name,
			namespace,
		});
	} catch (error) {
		console.error(`failed to terminate pod ${namespace}/${name}`, error);
	}
}

function Services({
	onHighlightedPodIdsChange,
	pods,
	services,
}: {
	onHighlightedPodIdsChange: (podIds: Set<string>) => void;
	pods: w8s.V1Pod[];
	services: w8s.V1Service[];
}) {
	return (
		<ResourceTable count={services.length} emptyLabel="No services match this namespace.">
			<Table.Head>
				<Table.Row>
					<Table.Header>Name</Table.Header>
					<Table.Header>Namespace</Table.Header>
					<Table.Header>Type</Table.Header>
					<Table.Header>Cluster IP</Table.Header>
					<Table.Header>Ports</Table.Header>
					<Table.Header>Selector</Table.Header>
					<Table.Header>Actions</Table.Header>
				</Table.Row>
			</Table.Head>
			<Table.Body>
				{services.map((service) => (
					<Table.Row
						key={idFor(service)}
						onPointerEnter={() => onHighlightedPodIdsChange(podIdsForService(service, pods))}
						onPointerLeave={() => onHighlightedPodIdsChange(new Set())}
					>
						<Table.Cell>{getName(service, "-")}</Table.Cell>
						<Table.Cell>{getNamespace(service) ?? "default"}</Table.Cell>
						<Table.Cell>{service.spec?.type ?? "ClusterIP"}</Table.Cell>
						<Table.Cell>{service.spec?.clusterIP ?? "-"}</Table.Cell>
						<Table.Cell>{formatServicePorts(service)}</Table.Cell>
						<Table.Cell>{formatSelector(service.spec?.selector)}</Table.Cell>
						<Table.Cell>
							<ResourceYamlPopover resource={service} />
						</Table.Cell>
					</Table.Row>
				))}
			</Table.Body>
		</ResourceTable>
	);
}

function Nodes({ nodes }: { nodes: w8s.V1Node[] }) {
	return (
		<ResourceTable count={nodes.length} emptyLabel="No nodes are registered.">
			<Table.Head>
				<Table.Row>
					<Table.Header>Name</Table.Header>
					<Table.Header>Status</Table.Header>
					<Table.Header>Pod CIDR</Table.Header>
					<Table.Header>Actions</Table.Header>
				</Table.Row>
			</Table.Head>
			<Table.Body>
				{nodes.map((node) => (
					<Table.Row key={idFor(node)}>
						<Table.Cell>{getName(node, "-")}</Table.Cell>
						<Table.Cell>{node.status?.phase === "NotReady" ? "Not ready" : "Ready"}</Table.Cell>
						<Table.Cell>{node.spec?.podCIDR ?? "-"}</Table.Cell>
						<Table.Cell>
							<ResourceYamlPopover resource={node} />
						</Table.Cell>
					</Table.Row>
				))}
			</Table.Body>
		</ResourceTable>
	);
}

function Namespaces({ namespaces }: { namespaces: w8s.V1Namespace[] }) {
	return (
		<ResourceTable count={namespaces.length} emptyLabel="No namespaces are registered.">
			<Table.Head>
				<Table.Row>
					<Table.Header>Name</Table.Header>
					<Table.Header>Status</Table.Header>
					<Table.Header>Actions</Table.Header>
				</Table.Row>
			</Table.Head>
			<Table.Body>
				{namespaces.map((namespace) => (
					<Table.Row key={idFor(namespace)}>
						<Table.Cell>{getName(namespace, "-")}</Table.Cell>
						<Table.Cell>{namespace.status?.phase ?? "Active"}</Table.Cell>
						<Table.Cell>
							<ResourceYamlPopover resource={namespace} />
						</Table.Cell>
					</Table.Row>
				))}
			</Table.Body>
		</ResourceTable>
	);
}

function Events({ events }: { events: w8s.CoreV1Event[] }) {
	return (
		<div className="h-80 overflow-y-auto contain-strict">
			<Table.Root>
				<Table.Element className="resource-table font-mono text-xs">
					<Table.Head>
						<Table.Row>
							<Table.Header>Time</Table.Header>
							<Table.Header>Type</Table.Header>
							<Table.Header>Object</Table.Header>
							<Table.Header>Reason</Table.Header>
							<Table.Header>Message</Table.Header>
							<Table.Header>Actions</Table.Header>
						</Table.Row>
					</Table.Head>
					<Table.Body>
						{events.map((event) => (
							<Table.Row key={idFor(event)}>
								<Table.Cell>{formatEventTime(event)}</Table.Cell>
								<Table.Cell>{event.type ?? "-"}</Table.Cell>
								<Table.Cell>
									{event.involvedObject.kind ?? "Object"}/{event.involvedObject.name ?? "-"}
								</Table.Cell>
								<Table.Cell>{event.reason ?? "-"}</Table.Cell>
								<Table.Cell>{event.message ?? "-"}</Table.Cell>
								<Table.Cell>
									<ResourceYamlPopover resource={event} />
								</Table.Cell>
							</Table.Row>
						))}
					</Table.Body>
				</Table.Element>
			</Table.Root>
		</div>
	);
}

function ResourceTable({
	children,
	count,
	emptyLabel,
}: {
	children: ReactNode;
	count: number;
	emptyLabel: string;
}) {
	return (
		<>
			<Table.Root>
				<Table.Element className="resource-table font-mono text-xs">{children}</Table.Element>
			</Table.Root>
			{count === 0 && <div className="text-muted p-4 text-sm">{emptyLabel}</div>}
		</>
	);
}

function RowActionIconButton({ label, ...props }: ComponentProps<typeof IconButton>) {
	return (
		<Tooltip.Root>
			<Tooltip.Trigger asChild>
				<IconButton label={label} {...props} />
			</Tooltip.Trigger>
			<Tooltip.Content>{label}</Tooltip.Content>
		</Tooltip.Root>
	);
}

function ResourceYamlPopover({ resource }: { resource: w8s.KubernetesObject }) {
	const yaml = useMemo(() => resourceYaml(resource), [resource]);
	const label = "Inspect manifest";
	const dialogLabel = `${getName(resource) || resource.kind || "Resource"} manifest`;
	return (
		<Tooltip.Root>
			<Popover.Root>
				<Tooltip.Trigger asChild>
					<Popover.Trigger asChild>
						<IconButton
							type="button"
							appearance="outlined"
							size="md"
							label={label}
							icon={<EyeIcon aria-hidden />}
						/>
					</Popover.Trigger>
				</Tooltip.Trigger>
				<Tooltip.Content>{label}</Tooltip.Content>
				<Popover.Content
					align="end"
					side="left"
					sideOffset={8}
					aria-label={dialogLabel}
					preferredWidth="max-w-[min(48rem,calc(100vw-2rem))]"
					className="p-3"
					style={{ width: "min(48rem, calc(100vw - 2rem))" }}
				>
					<HighlightedYamlCode code={yaml} />
				</Popover.Content>
			</Popover.Root>
		</Tooltip.Root>
	);
}

function HighlightedYamlCode({ code }: { code: string }) {
	const appliedTheme = useAppliedTheme();
	const shikiTheme = appliedTheme.startsWith("dark") ? "github-dark" : "github-light";
	const [highlightedHtml, setHighlightedHtml] = useState<string>();

	useEffect(() => {
		let cancelled = false;
		void highlightYaml(code, shikiTheme).then(
			(html) => {
				if (!cancelled) {
					setHighlightedHtml(html);
				}
				return null;
			},
			() => {
				if (!cancelled) {
					setHighlightedHtml(undefined);
				}
			},
		);
		return () => {
			cancelled = true;
		};
	}, [code, shikiTheme]);

	const value = useMemo<MantleCodeBlockValue>(
		() =>
			createMantleCodeBlockValue({
				language: "yaml",
				code,
				preHtml: highlightedHtml,
				showLineNumbers: false,
			}),
		[code, highlightedHtml],
	);

	return (
		<CodeBlock.Root className="w-full max-w-full border-0 bg-transparent text-[0.6875rem]">
			<CodeBlock.Body>
				<CodeBlock.Code
					value={value}
					tabIndex={0}
					className="max-h-96 w-full text-[0.6875rem] leading-snug"
					style={{ margin: 0, overflow: "auto", padding: 0 }}
				/>
			</CodeBlock.Body>
		</CodeBlock.Root>
	);
}

function resourceYaml(resource: w8s.KubernetesObject): string {
	return stringifyYaml(JSON.parse(JSON.stringify(resource)));
}

const highlightedYamlCache = new Map<string, Promise<string>>();

async function highlightYaml(code: string, theme: string): Promise<string> {
	const cacheKey = `${theme}\n${code}`;
	let promise = highlightedYamlCache.get(cacheKey);
	if (!promise) {
		promise = renderHighlightedYaml(code, theme);
		highlightedYamlCache.set(cacheKey, promise);
	}
	return promise;
}

async function renderHighlightedYaml(code: string, theme: string): Promise<string> {
	const html = await codeToHtml(code, {
		lang: "yaml",
		theme,
	});
	return decorateHighlightedHtml({
		html: extractShikiCodeHtml(html),
		showLineNumbers: false,
	});
}

function extractShikiCodeHtml(html: string): string {
	// Shiki returns a full <pre><code> block, but Mantle CodeBlock renders that wrapper itself.
	const template = document.createElement("template");
	template.innerHTML = html;
	return template.content.querySelector("code")?.innerHTML ?? html;
}

function formatServicePorts(service: w8s.V1Service): string {
	return (
		service.spec?.ports
			?.map((port) => `${port.port}:${port.targetPort ?? port.port}/${port.protocol ?? "TCP"}`)
			.join(", ") ?? "-"
	);
}

function formatSelector(selector: Record<string, string> | undefined): string {
	if (!selector) {
		return "-";
	}
	return Object.entries(selector)
		.map(([key, value]) => `${key}=${value}`)
		.join(", ");
}

function formatLabelSelector(selector: w8s.V1LabelSelector | undefined): string {
	const parts = [
		...Object.entries(selector?.matchLabels ?? {}).map(([key, value]) => `${key}=${value}`),
		...(selector?.matchExpressions ?? []).map((expression) => {
			const values = expression.values?.join(",") ?? "";
			return values
				? `${expression.key} ${expression.operator} (${values})`
				: `${expression.key} ${expression.operator}`;
		}),
	];
	return parts.length === 0 ? "-" : parts.join(", ");
}

function formatEventTime(event: w8s.CoreV1Event): string {
	const value = eventTimestamp(event);
	if (!value) {
		return "-";
	}
	return new Date(value).toLocaleTimeString();
}

function sortEventsByTimestampDescending(events: w8s.CoreV1Event[]): w8s.CoreV1Event[] {
	return [...events].toSorted((a, b) => {
		const time = eventTimeMs(b) - eventTimeMs(a);
		if (time !== 0) {
			return time;
		}
		return idFor(b).localeCompare(idFor(a));
	});
}

function eventTimeMs(event: w8s.CoreV1Event): number {
	const value = eventTimestamp(event);
	return value ? new Date(value).getTime() : 0;
}

function eventTimestamp(event: w8s.CoreV1Event): string | Date | undefined {
	return event.eventTime ?? event.lastTimestamp ?? event.firstTimestamp;
}
