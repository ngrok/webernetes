import type { V1ExecAction } from "../../../client";
import type { ContainerInstance, Runtime } from "../../cri";
import type { ProbeResult } from "../probe";

export class ExecProber {
	constructor(private readonly runtime: Runtime) {}

	// Models kubernetes/pkg/probe/exec/exec.go Probe.
	async probe(
		container: ContainerInstance,
		action: V1ExecAction,
		timeoutMs: number,
	): Promise<ProbeResult> {
		const result = await this.runtime.execSync(
			container.id,
			expandCommand(action.command ?? [], container.env),
			{ timeoutMs },
		);
		return result.exitCode === 0 ? "success" : "failure";
	}
}

function expandCommand(command: readonly string[], env: ReadonlyMap<string, string>): string[] {
	return command.map((arg) =>
		arg.replace(
			/\$\(([-._a-zA-Z][-._a-zA-Z0-9]*)\)/g,
			(match, name: string) => env.get(name) ?? match,
		),
	);
}
