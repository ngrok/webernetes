import { Card } from "@ngrok/mantle/card";
import { Table } from "@ngrok/mantle/table";
import { Tabs } from "@ngrok/mantle/tabs";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import * as w8s from "webernetes";

import {
	getName,
	getNamespace,
	getReadyContainers,
	getRestartCount,
	idFor,
	sortByName,
} from "../helpers";
import { useInformer } from "../hooks";

type ResourceTab = "pods" | "services" | "nodes" | "namespaces" | "events";

export function ResourcesTabs({
	cluster,
	namespace,
}: {
	cluster: w8s.Cluster;
	namespace: string | undefined;
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
	});

	const counts = useMemo(
		() => ({
			pods: pods.length,
			services: services.length,
			nodes: nodes.length,
			namespaces: namespaces.length,
			events: events.length,
		}),
		[events.length, namespaces.length, nodes.length, pods.length, services.length],
	);

	return (
		<Card.Root>
			<Tabs.Root
				appearance="pill"
				value={tab}
				onValueChange={(value) => setTab(value as ResourceTab)}
			>
				<Card.Body>
					<Tabs.List className="mb-4 flex flex-wrap gap-2">
						<Tabs.Trigger value="pods">
							Pods
							<Tabs.Badge>{counts.pods}</Tabs.Badge>
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
						<Pods pods={pods} />
					</Tabs.Content>
					<Tabs.Content value="services">
						<Services services={services} />
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

function Pods({ pods }: { pods: w8s.V1Pod[] }) {
	return (
		<ResourceTable count={pods.length} emptyLabel="No pods match this namespace.">
			<Table.Head>
				<Table.Row>
					<Table.Header>Name</Table.Header>
					<Table.Header>Namespace</Table.Header>
					<Table.Header>Phase</Table.Header>
					<Table.Header>Node</Table.Header>
					<Table.Header>Ready</Table.Header>
					<Table.Header>Restarts</Table.Header>
				</Table.Row>
			</Table.Head>
			<Table.Body>
				{pods.map((pod) => (
					<Table.Row key={idFor(pod)}>
						<Table.Cell>{getName(pod, "-")}</Table.Cell>
						<Table.Cell>{getNamespace(pod) ?? "default"}</Table.Cell>
						<Table.Cell>{pod.status?.phase ?? "Pending"}</Table.Cell>
						<Table.Cell>{pod.spec?.nodeName ?? "unscheduled"}</Table.Cell>
						<Table.Cell>
							{getReadyContainers(pod)}/{pod.spec?.containers?.length ?? 0}
						</Table.Cell>
						<Table.Cell>{getRestartCount(pod)}</Table.Cell>
					</Table.Row>
				))}
			</Table.Body>
		</ResourceTable>
	);
}

function Services({ services }: { services: w8s.V1Service[] }) {
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
				</Table.Row>
			</Table.Head>
			<Table.Body>
				{services.map((service) => (
					<Table.Row key={idFor(service)}>
						<Table.Cell>{getName(service, "-")}</Table.Cell>
						<Table.Cell>{getNamespace(service) ?? "default"}</Table.Cell>
						<Table.Cell>{service.spec?.type ?? "ClusterIP"}</Table.Cell>
						<Table.Cell>{service.spec?.clusterIP ?? "-"}</Table.Cell>
						<Table.Cell>{formatServicePorts(service)}</Table.Cell>
						<Table.Cell>{formatSelector(service.spec?.selector)}</Table.Cell>
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
				</Table.Row>
			</Table.Head>
			<Table.Body>
				{nodes.map((node) => (
					<Table.Row key={idFor(node)}>
						<Table.Cell>{getName(node, "-")}</Table.Cell>
						<Table.Cell>{node.status?.phase === "NotReady" ? "Not ready" : "Ready"}</Table.Cell>
						<Table.Cell>{node.spec?.podCIDR ?? "-"}</Table.Cell>
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
				</Table.Row>
			</Table.Head>
			<Table.Body>
				{namespaces.map((namespace) => (
					<Table.Row key={idFor(namespace)}>
						<Table.Cell>{getName(namespace, "-")}</Table.Cell>
						<Table.Cell>{namespace.status?.phase ?? "Active"}</Table.Cell>
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

function formatEventTime(event: w8s.CoreV1Event): string {
	const value = event.eventTime ?? event.lastTimestamp ?? event.firstTimestamp;
	if (!value) {
		return "-";
	}
	return new Date(value).toLocaleTimeString();
}
