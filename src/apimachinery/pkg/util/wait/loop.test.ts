import { expect, it } from "vitest";

import { Channel, type ReadOnlyChannel } from "../../../../go/channel";
import * as context from "../../../../go/context";
import { browser } from "../../../../test/describe";
import { Clock } from "../../../../clock";
import { DelayFunc } from "./delay";
import { loopConditionUntilContext } from "./loop";
import { newNoopTimer, type Timer, VariableTimer } from "./timer";

browser.describe("loopConditionUntilContext", () => {
	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/loop_test.go Test_loopConditionWithContextImmediateDelay.
	it("waits for the timer before the first non-immediate condition call", async () => {
		const expectedError = new Error("Expected error");
		const timer = new ManualTimer();
		let attempts = 0;

		const promise = loopConditionUntilContext(context.background(), timer, false, true, () => {
			attempts++;
			return [false, expectedError];
		});

		await Promise.resolve();
		expect(attempts).toBe(0);

		timer.fire();
		await expect(promise).resolves.toBe(expectedError);
		expect(attempts).toBe(1);
	});

	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/loop_test.go Test_loopConditionUntilContext_semantic.
	it("matches upstream semantic loop cases", async () => {
		const conditionErr = new Error("condition failed");
		const tests: Array<{
			name: string;
			immediate?: boolean;
			sliding?: boolean;
			makeContext?: () => [context.Context, context.CancelFunc];
			callback: (calls: number) => [boolean, Error | undefined];
			cancelContextAfter?: number;
			attemptsExpected: number;
			errExpected?: Error;
			timer?: Timer;
		}> = [
			{
				name: "condition successful is only one attempt",
				callback: () => [true, undefined],
				attemptsExpected: 1,
			},
			{
				name: "delayed condition successful causes return and attempts",
				callback: (attempts) => [attempts > 1, undefined],
				attemptsExpected: 2,
			},
			{
				name: "delayed condition successful causes return and attempts many times",
				callback: (attempts) => [attempts >= 100, undefined],
				attemptsExpected: 100,
			},
			{
				name: "condition returns error even if ok is true",
				callback: () => [true, conditionErr],
				attemptsExpected: 1,
				errExpected: conditionErr,
			},
			{
				name: "condition exits after an error",
				callback: () => [false, conditionErr],
				attemptsExpected: 1,
				errExpected: conditionErr,
			},
			{
				name: "context already canceled no attempts expected",
				makeContext: cancelledContext,
				callback: () => [false, undefined],
				attemptsExpected: 0,
				errExpected: context.Canceled,
			},
			{
				name: "context already canceled condition success and immediate 1 attempt expected",
				makeContext: cancelledContext,
				callback: () => [true, undefined],
				immediate: true,
				attemptsExpected: 1,
			},
			{
				name: "context already canceled condition fail and immediate 1 attempt expected",
				makeContext: cancelledContext,
				callback: () => [false, conditionErr],
				immediate: true,
				attemptsExpected: 1,
				errExpected: conditionErr,
			},
			{
				name: "context already canceled and immediate 1 attempt expected",
				makeContext: cancelledContext,
				callback: () => [false, undefined],
				immediate: true,
				attemptsExpected: 1,
				errExpected: context.Canceled,
			},
			{
				name: "context cancelled after 5 attempts",
				callback: () => [false, undefined],
				cancelContextAfter: 5,
				attemptsExpected: 5,
				errExpected: context.Canceled,
			},
			{
				name: "context cancelled and immediate after 5 attempts",
				callback: () => [false, undefined],
				immediate: true,
				cancelContextAfter: 5,
				attemptsExpected: 5,
				errExpected: context.Canceled,
			},
		];

		for (const test of tests) {
			const [ctx, cancel] = test.makeContext?.() ?? context.withCancel(context.background());
			const timer = test.timer ?? newNoopTimer();
			let attempts = 0;
			const err = await loopConditionUntilContext(
				ctx,
				timer,
				test.immediate ?? false,
				test.sliding ?? false,
				() => {
					attempts++;
					try {
						return test.callback(attempts);
					} finally {
						if (test.cancelContextAfter && test.cancelContextAfter === attempts) {
							cancel();
						}
					}
				},
			);

			expect(err).toBe(test.errExpected);
			expect(attempts).toBe(test.attemptsExpected);
			cancel();
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/loop_test.go Test_loopConditionUntilContext_timings.
	it("passes delay intervals to the timer in the upstream order", async () => {
		const tests: Array<{
			name: string;
			immediate?: boolean;
			sliding?: boolean;
			delays: number[];
			callback: (calls: number, lastInterval: number) => [boolean, Error | undefined];
			attemptsExpected: number;
			expectedDelaysRequested: number[];
		}> = [
			{
				name: "condition success",
				delays: [1000, 2000],
				callback: () => [true, undefined],
				attemptsExpected: 1,
				expectedDelaysRequested: [1000, 2000],
			},
			{
				name: "condition success and immediate",
				immediate: true,
				delays: [1000, 2000],
				callback: () => [true, undefined],
				attemptsExpected: 1,
				expectedDelaysRequested: [1000],
			},
			{
				name: "condition success and sliding",
				sliding: true,
				delays: [1000, 2000],
				callback: () => [true, undefined],
				attemptsExpected: 1,
				expectedDelaysRequested: [1000],
			},
		];

		for (const test of tests) {
			const timer = newRecordingVariableTimer(test.delays);
			let attempts = 0;
			const err = await loopConditionUntilContext(
				context.background(),
				timer,
				test.immediate ?? false,
				test.sliding ?? false,
				() => {
					attempts++;
					const lastInterval = timer.wrapper.resets.at(-1) ?? -1;
					return test.callback(attempts, lastInterval);
				},
			);

			expect(err).toBeUndefined();
			expect(attempts).toBe(test.attemptsExpected);
			expect(timer.wrapper.resets).toEqual(test.expectedDelaysRequested);
		}
	});
});

class ManualTimer implements Timer {
	private readonly ch = new Channel<Date>();
	stopped = false;

	c(): ReadOnlyChannel<Date> {
		return this.ch.readOnly();
	}

	next(): void {}

	stop(): void {
		this.stopped = true;
	}

	fire(): void {
		this.ch.trySend(new Date(0));
	}
}

class TimerWrapper {
	readonly resets: number[] = [];
	private readonly ch = new Channel<Date>(1);

	constructor(delayMs: number) {
		this.resets.push(delayMs);
		this.fire();
	}

	get C(): ReadOnlyChannel<Date> {
		return this.ch.readOnly();
	}

	reset(delayMs: number): boolean {
		this.resets.push(delayMs);
		this.fire();
		return true;
	}

	stop(): boolean {
		return true;
	}

	private fire(): void {
		this.ch.trySend(new Date(0));
	}
}

function newRecordingVariableTimer(delays: number[]): VariableTimer & { wrapper: TimerWrapper } {
	const clock = new Clock();
	let index = 0;
	const delayFunc = new DelayFunc(() => delays[index++] ?? 0, clock);
	let wrapper: TimerWrapper | undefined;
	const timer = new VariableTimer(delayFunc, (delayMs) => {
		wrapper = new TimerWrapper(delayMs);
		return wrapper;
	}) as VariableTimer & { wrapper: TimerWrapper };
	Object.defineProperty(timer, "wrapper", {
		get: () => {
			if (!wrapper) {
				throw new Error("timer was not created");
			}
			return wrapper;
		},
	});
	return timer;
}

function cancelledContext(): [context.Context, context.CancelFunc] {
	const [ctx, cancel] = context.withCancel(context.background());
	cancel();
	return [ctx, cancel];
}
