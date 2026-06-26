import { Button } from "@ngrok/mantle/button";
import { Select } from "@ngrok/mantle/select";
import { GithubLogo } from "@phosphor-icons/react";
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
		<header className="demo-header">
			<div className="demo-top-nav">
				<div className="mx-auto flex h-full w-full max-w-7xl items-center justify-between gap-4 px-4 md:px-6">
					<a className="demo-ngrok-logo" href="/" aria-label="Webernetes demo home">
						<span className="demo-ngrok-wordmark" aria-hidden="true" />
						<span className="sr-only">ngrok</span>
						<span className="demo-brand-slash">/</span>
						<span className="demo-brand-product">webernetes</span>
					</a>
					<nav className="flex items-center gap-2" aria-label="Project links">
						<Button asChild appearance="outlined" priority="neutral">
							<a
								className="demo-repo-link"
								href="https://github.com/ngrok/webernetes"
								target="_blank"
								rel="noreferrer"
							>
								<GithubLogo aria-hidden="true" size={18} weight="fill" />
								<span>GitHub repo</span>
							</a>
						</Button>
					</nav>
				</div>
			</div>

			<div className="demo-controls-row">
				<div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-end gap-3 px-4 md:px-6">
					<div className="w-48">
						<Select.Root
							value={namespace ?? "__all_namespaces__"}
							onValueChange={(value) =>
								onNamespaceChange(value === "__all_namespaces__" ? undefined : value)
							}
						>
							<Select.Trigger>
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
				</div>
			</div>
		</header>
	);
}
