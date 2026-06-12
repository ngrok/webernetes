import { Badge } from "@ngrok/mantle/badge";
import { Tooltip } from "@ngrok/mantle/tooltip";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import * as w8s from "webernetes";
import { getName, getNamespace, getReadyContainers, getRestartCount } from "../helpers";

export function Pod({ pod }: { pod: w8s.V1Pod }) {
	return (
		<Tooltip.Root>
			<Tooltip.Trigger asChild>
				<PodContent pod={pod} />
			</Tooltip.Trigger>
			<Tooltip.Content className="max-w-80">
				<TooltipContent pod={pod} />
			</Tooltip.Content>
		</Tooltip.Root>
	);
}

type PodContentProps = ComponentPropsWithoutRef<"div"> & {
	pod: w8s.V1Pod;
};

const PodContent = forwardRef<HTMLDivElement, PodContentProps>(function PodContent(
	{ pod, ...props },
	ref,
) {
	const name = getName(pod);
	const ready = isPodReady(pod);

	return (
		<div
			ref={ref}
			{...props}
			className="border-card bg-card flex min-h-20 min-w-0 flex-col items-center justify-center gap-2 rounded-md border p-3 text-center transition-transform hover:-translate-y-0.5"
		>
			<div className="w-full min-w-0 truncate font-mono text-xs font-semibold">{name}</div>
			<Badge appearance="muted" color={ready ? "success" : "warning"}>
				{ready ? "Ready" : "Not ready"}
			</Badge>
		</div>
	);
});

function TooltipContent({ pod }: { pod: w8s.V1Pod }) {
	const containers = pod.spec?.containers ?? [];

	return (
		<div className="space-y-1 font-sans text-xs">
			<div className="font-mono font-semibold">{getName(pod)}</div>
			<div>Namespace: {getNamespace(pod)}</div>
			<div>Phase: {pod.status?.phase ?? "Unknown"}</div>
			<div>
				Ready: {getReadyContainers(pod)}/{containers.length}
			</div>
			<div>Restarts: {getRestartCount(pod)}</div>
			<div>Node: {pod.spec?.nodeName ?? ""}</div>
		</div>
	);
}

function isPodReady(pod: w8s.V1Pod): boolean {
	const condition = pod.status?.conditions?.find((c) => c.type === "Ready");
	return condition?.status === "True";
}
