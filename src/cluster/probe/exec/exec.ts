import type { V1Container, V1ExecAction } from "../../../client";
import type { CommandRunner, ContainerID } from "../../kubelet/container";
import type { ProbeResult } from "../probe";

export class ExecProber {
	constructor(private readonly runner: CommandRunner) {}

	// Models kubernetes/pkg/probe/exec/exec.go Probe.
	async probe(
		containerId: ContainerID,
		container: V1Container,
		action: V1ExecAction,
		timeoutMs: number,
	): Promise<ProbeResult> {
		const [, err] = await this.runner.runInContainer(
			containerId,
			expandCommand(action.command ?? [], container.env ?? []),
			timeoutMs / 1000,
		);
		return err ? "failure" : "success";
	}
}

function expandCommand(command: readonly string[], env: NonNullable<V1Container["env"]>): string[] {
	const values = new Map(
		env
			.filter((entry) => entry.value !== undefined)
			.map((entry) => [entry.name, entry.value ?? ""]),
	);
	return command.map((arg) =>
		arg.replace(
			/\$\(([-._a-zA-Z][-._a-zA-Z0-9]*)\)/g,
			(match, name: string) => values.get(name) ?? match,
		),
	);
}
