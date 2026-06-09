/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { errCommandTimedOut } from "../../cri-client/pkg";
import { isExitError } from "../../kubelet/container";
import type { ProbeResult } from "../probe";

// Models kubernetes/pkg/probe/exec/exec.go maxReadLength.
const maxReadLength = (10 * 1) << 10;

export interface ByteWriter {
	write(chunk: string): [written: number, err: Error | undefined];
}

export interface ExecCmd {
	run(): Error | undefined;
	combinedOutput(): Promise<[string, Error | undefined]>;
	output(): [string, Error | undefined];
	setDir(dir: string): void;
	setStdin(input: unknown): void;
	setStdout(out: ByteWriter): void;
	setStderr(out: ByteWriter): void;
	setEnv(env: string[]): void;
	stop(): void;
	start(): Promise<Error | undefined>;
	wait(): Promise<Error | undefined>;
	stdoutPipe(): [unknown, Error | undefined];
	stderrPipe(): [unknown, Error | undefined];
}

// Models kubernetes/pkg/probe/exec/exec.go Prober.
export interface ExecProbe {
	probe(e: ExecCmd): Promise<[ProbeResult, string, Error | undefined]>;
}

export class ExecProber implements ExecProbe {
	// Models kubernetes/pkg/probe/exec/exec.go Probe.
	async probe(e: ExecCmd): Promise<[ProbeResult, string, Error | undefined]> {
		const dataBuffer = new LimitedStringWriter(maxReadLength);

		e.setStderr(dataBuffer);
		e.setStdout(dataBuffer);
		let err = await e.start();
		if (!err) {
			err = await e.wait();
		}
		const data = dataBuffer.toString();

		if (isExitError(err)) {
			if (err.exitStatus() === 0) {
				return ["success", data, undefined];
			}
			return ["failure", data, undefined];
		}
		if (err) {
			if (isCommandTimedOut(err)) {
				return ["failure", err.message, undefined];
			}
			return ["unknown", "", err];
		}
		return ["success", data, undefined];
	}
}

class LimitedStringWriter implements ByteWriter {
	private value = "";

	constructor(private readonly limit: number) {}

	write(chunk: string): [written: number, err: Error | undefined] {
		const remaining = this.limit - this.value.length;
		if (remaining <= 0) {
			return [0, undefined];
		}
		const written = chunk.slice(0, remaining);
		this.value += written;
		return [written.length, undefined];
	}

	toString(): string {
		return this.value;
	}
}

// Models kubernetes/pkg/probe/exec/exec.go errors.Is(err, remote.ErrCommandTimedOut).
function isCommandTimedOut(err: Error): boolean {
	let current: unknown = err;
	while (current) {
		if (current === errCommandTimedOut) {
			return true;
		}
		if (!(current instanceof Error)) {
			return false;
		}
		current = (current as Error & { cause?: unknown }).cause;
	}
	return false;
}
