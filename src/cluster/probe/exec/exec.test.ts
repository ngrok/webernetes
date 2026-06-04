// oxlint-disable jest/no-conditional-expect
import { expect, it } from "vitest";

import { errCommandTimedOut } from "../../cri-client/pkg";
import { browser } from "../../../test/describe";
import type { ProbeResult } from "../probe";
import { ExecProber, type ByteWriter, type ExecCmd } from "./exec";

// Models kubernetes/pkg/probe/exec/exec_test.go FakeCmd.
class FakeCmd implements ExecCmd {
	writer: ByteWriter | undefined;

	constructor(
		readonly out: string,
		readonly stdout = "",
		readonly err?: Error,
	) {}

	run(): Error | undefined {
		return undefined;
	}

	async combinedOutput(): Promise<[string, Error | undefined]> {
		return [this.out, this.err];
	}

	output(): [string, Error | undefined] {
		return [this.stdout, this.err];
	}

	setDir(_dir: string): void {}

	setStdin(_input: unknown): void {}

	setStdout(out: ByteWriter): void {
		this.writer = out;
	}

	setStderr(out: ByteWriter): void {
		this.writer = out;
	}

	setEnv(_env: string[]): void {}

	stop(): void {}

	async start(): Promise<Error | undefined> {
		if (this.writer) {
			this.writer.write(this.out);
			return this.err;
		}
		return this.err;
	}

	async wait(): Promise<Error | undefined> {
		return undefined;
	}

	stdoutPipe(): [unknown, Error | undefined] {
		return [undefined, undefined];
	}

	stderrPipe(): [unknown, Error | undefined] {
		return [undefined, undefined];
	}
}

// Models kubernetes/pkg/probe/exec/exec_test.go fakeExitError.
class FakeExitError extends Error {
	constructor(
		private readonly exitedValue: boolean,
		private readonly statusCode: number,
	) {
		super("fake exit");
	}

	exited(): boolean {
		return this.exitedValue;
	}

	exitStatus(): number {
		return this.statusCode;
	}
}

// Models kubernetes/pkg/probe/exec/exec_test.go TestExec.
browser.describe("TestExec", () => {
	it("maps command results like upstream", async () => {
		const prober = new ExecProber();

		const tenKilobyte = "logs-123".repeat(128 * 10);
		const elevenKilobyte = "logs-123".repeat(8 * 128 * 11);

		const tests: Array<{
			expectedStatus: ProbeResult;
			expectError: boolean;
			input: string;
			output: string;
			err: Error | undefined;
		}> = [
			// Ok
			{ expectedStatus: "success", expectError: false, input: "OK", output: "OK", err: undefined },
			// Ok
			{
				expectedStatus: "success",
				expectError: false,
				input: "OK",
				output: "OK",
				err: new FakeExitError(true, 0),
			},
			// Ok - truncated output
			{
				expectedStatus: "success",
				expectError: false,
				input: elevenKilobyte,
				output: tenKilobyte,
				err: undefined,
			},
			// Run returns error
			{
				expectedStatus: "unknown",
				expectError: true,
				input: "",
				output: "",
				err: new Error("test error"),
			},
			// Unhealthy
			{
				expectedStatus: "failure",
				expectError: false,
				input: "Fail",
				output: "",
				err: new FakeExitError(true, 1),
			},
			// Timeout
			{
				expectedStatus: "failure",
				expectError: false,
				input: "",
				output: "command timed out: command testcmd timed out",
				err: new Error("command timed out: command testcmd timed out", {
					cause: errCommandTimedOut,
				}),
			},
		];

		for (const [i, test] of tests.entries()) {
			const fake = new FakeCmd(test.output, "", test.err);
			const [status, output, err] = await prober.probe(fake);
			if (status !== test.expectedStatus) {
				expect.fail(`[${i}] expected ${test.expectedStatus}, got ${status}`);
			}
			if (err && !test.expectError) {
				expect.fail(`[${i}] unexpected error: ${err.message}`);
			}
			if (!err && test.expectError) {
				expect.fail(`[${i}] unexpected non-error`);
			}
			if (test.output !== output) {
				expect.fail(`[${i}] expected ${test.output}, got ${output}`);
			}
		}
	});
});
