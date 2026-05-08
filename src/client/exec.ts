import { KubeConfig } from "./config";
import type { V1Status } from "./gen/models";
import type { Exec as ExecInterface, ExecReadable, ExecWebSocket, ExecWritable } from "./types";

export class Exec implements ExecInterface {
	constructor(
		private readonly config: KubeConfig,
		_wsInterface?: unknown,
	) {}

	async exec(
		namespace: string,
		podName: string,
		containerName: string,
		command: string | string[],
		stdout: ExecWritable | null,
		stderr: ExecWritable | null,
		_stdin: ExecReadable | null,
		tty: boolean,
		statusCallback?: (status: V1Status) => void,
	): Promise<ExecWebSocket> {
		if (tty) {
			throw new Error("TTY exec sessions are not supported by the simulator");
		}
		const argv = Array.isArray(command) ? command : [command];
		const result = await this.config.cluster.exec(namespace, podName, containerName, argv);
		if (result.stdout) {
			stdout?.write(result.stdout);
		}
		if (result.stderr) {
			stderr?.write(result.stderr);
		}
		statusCallback?.(execStatus(result.exitCode));
		return {
			close() {},
		};
	}
}

function execStatus(exitCode: number): V1Status {
	if (exitCode === 0) {
		return {
			apiVersion: "v1",
			kind: "Status",
			status: "Success",
		};
	}
	return {
		apiVersion: "v1",
		kind: "Status",
		status: "Failure",
		reason: "NonZeroExitCode",
		message: `command terminated with exit code ${exitCode}`,
		details: {
			causes: [{ reason: "ExitCode", message: String(exitCode) }],
		},
	};
}
