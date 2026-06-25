import { Button } from "@ngrok/mantle/button";
import { Select } from "@ngrok/mantle/select";
import * as w8s from "webernetes";

import { getName, idFor, sortByName } from "../helpers";
import { useInformer } from "../hooks";
import { ClusterPauseButton } from "./cluster-pause-button";
import { ThemeToggle } from "./theme-toggle";

export function Header({
	cluster,
	namespace,
	onNamespaceChange,
	onReset,
}: {
	cluster: w8s.Cluster;
	namespace: string | undefined;
	onNamespaceChange: (value: string | undefined) => void;
	onReset: () => void;
}) {
	const namespaces = useInformer({
		cluster,
		resource: "namespaces",
		sort: sortByName,
	});

	return (
		<header className="flex flex-wrap items-center justify-end gap-4">
			<h1 className="sr-only">webernetes demo</h1>
			<div className="w-48">
				<Select.Root
					value={namespace ?? "__all_namespaces__"}
					onValueChange={(value) =>
						onNamespaceChange(value === "__all_namespaces__" ? undefined : value)
					}
				>
					<Select.Trigger aria-label="Namespace">
						<Select.Value />
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="__all_namespaces__">All namespaces</Select.Item>
						{namespaces.map((item) => {
							const name = getName(item);
							return (
								<Select.Item key={idFor(item)} value={name}>
									{name}
								</Select.Item>
							);
						})}
					</Select.Content>
				</Select.Root>
			</div>
			<ThemeToggle />
			<ClusterPauseButton cluster={cluster} />
			<Button type="button" priority="danger" onClick={onReset}>
				Reset
			</Button>
		</header>
	);
}
