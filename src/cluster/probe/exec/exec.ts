import type { V1Container, V1ExecAction } from "../../../client";
import type * as context from "../../../go/context";
import { isExitError, type CommandRunner, type ContainerID } from "../../kubelet/container";
import type { ProbeResult } from "../probe";

export class ExecProber {
	constructor(private readonly runner: CommandRunner) {}

	// Models kubernetes/pkg/probe/exec/exec.go Probe.
	async probe(
		ctx: context.Context,
		containerId: ContainerID,
		container: V1Container,
		action: V1ExecAction,
		timeoutMs: number,
	): Promise<[ProbeResult, string, Error | undefined]> {
		// TODO(samwho): the way timeouts come back to us here is that they return
		// an error code 124. That doesn't seem to be how upstream does it they
		// return a remote.ErrCommandTimedOut. In fact, the structure of exec.go is
		// quite different to this and this class needs revisiting at some point.
		const [output, err] = await this.runner.runInContainer(
			ctx,
			containerId,
			expandCommand(action.command ?? [], container.env ?? []),
			timeoutMs / 1000,
		);
		if (isExitError(err)) {
			return [err.exitStatus() === 0 ? "success" : "failure", output, undefined];
		}
		if (err) {
			return ["unknown", "", err];
		}
		return ["success", output, undefined];
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
