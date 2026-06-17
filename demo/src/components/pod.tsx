import { Badge } from "@ngrok/mantle/badge";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import * as w8s from "webernetes";
import { getName, hasReadiness, idFor } from "../helpers";

export function Pod({ highlighted = false, pod }: { highlighted?: boolean; pod: w8s.V1Pod }) {
	return <PodContent highlighted={highlighted} pod={pod} />;
}

type PodContentProps = ComponentPropsWithoutRef<"div"> & {
	highlighted: boolean;
	pod: w8s.V1Pod;
};

const PodContent = forwardRef<HTMLDivElement, PodContentProps>(function PodContent(
	{ highlighted, pod, ...props },
	ref,
) {
	const name = getName(pod);
	const ready = isPodReady(pod);
	const showReadiness = hasReadiness(pod);

	return (
		<div
			id={idFor(pod)}
			ref={ref}
			{...props}
			className={`border-card bg-card flex min-h-20 min-w-0 flex-col items-center justify-center gap-2 rounded-md border p-3 text-center transition-colors ${
				highlighted ? "border-accent-600 bg-accent-500/10 ring-accent-600 shadow-sm ring-2" : ""
			}`}
		>
			<div className="w-full min-w-0 truncate font-mono text-xs font-semibold">{name}</div>
			{showReadiness && (
				<Badge appearance="muted" color={ready ? "success" : "warning"}>
					{ready ? "Ready" : "Not ready"}
				</Badge>
			)}
		</div>
	);
});

function isPodReady(pod: w8s.V1Pod): boolean {
	const condition = pod.status?.conditions?.find((c) => c.type === "Ready");
	return condition?.status === "True";
}
