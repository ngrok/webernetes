// oxlint-disable vitest/no-conditional-tests
// oxlint-disable vitest/warn-todo
import { beforeEach as vitestBeforeEach, describe as vitestDescribe } from "vitest";
import type { TestOptions } from "vitest";
import { Clock } from "../clock";
import { getClock, withClock } from "../clock-context";
import * as context from "../go/context";
import { withLatencyProvider } from "../latency";

export type TestEnvironment = "browser" | "node";
export type SuiteOptions = number | TestOptions;

export interface BrowserTestContext {
	ctx: context.Context;
}

export type SuiteFactory = (context: BrowserTestContext) => void;

type DescribeArguments =
	| [name: string, factory: SuiteFactory]
	| [name: string, options: SuiteOptions, factory: SuiteFactory];

type DescribeMode = "run" | "skip" | "only" | "todo";

export interface EnvironmentDescribe {
	describe: EnvironmentDescribeFn;
}

export interface EnvironmentDescribeFn {
	(...args: DescribeArguments): void;
	only: (...args: DescribeArguments) => void;
	skip: (...args: DescribeArguments) => void;
	todo: (name: string) => void;
}

export const currentTestEnvironment: TestEnvironment = isBrowserTestEnvironment()
	? "browser"
	: "node";

export const node: EnvironmentDescribe = createEnvironmentDescribe("node");
export const browser: EnvironmentDescribe = createEnvironmentDescribe("browser");
export const both: EnvironmentDescribe = createEnvironmentDescribe("both");

function createEnvironmentDescribe(target: TestEnvironment | "both"): EnvironmentDescribe {
	const describe = createDescribeFn(target, "run") as EnvironmentDescribeFn;
	describe.only = createDescribeFn(target, "only");
	describe.skip = createDescribeFn(target, "skip");
	describe.todo = (name: string) => {
		vitestDescribe.todo(name);
	};
	return { describe };
}

function createDescribeFn(
	target: TestEnvironment | "both",
	mode: DescribeMode,
): (...args: DescribeArguments) => void {
	return (...args: DescribeArguments) => {
		const [name, maybeOptions, maybeFactory] = args;
		const { options, factory } =
			typeof maybeOptions === "function"
				? { options: undefined, factory: maybeOptions }
				: { options: maybeOptions, factory: maybeFactory };

		if (mode === "todo") {
			vitestDescribe.todo(name);
			return;
		}

		if (mode === "skip" || !shouldRun(target)) {
			return;
		}

		if (!factory) {
			throw new Error(`Missing describe callback for ${name}`);
		}

		const describeFn = mode === "only" ? vitestDescribe.only : vitestDescribe;
		const wrappedFactory = () => {
			const testContext = createBrowserTestContext();
			vitestBeforeEach(() => {
				getClock(testContext.ctx).reset();
			});
			factory(testContext);
		};
		if (options === undefined) {
			describeFn(name, wrappedFactory);
			return;
		}
		if (typeof options === "number") {
			describeFn(name, wrappedFactory, options);
			return;
		}
		describeFn(name, options, wrappedFactory);
	};
}

function createBrowserTestContext(): BrowserTestContext {
	return {
		ctx: withLatencyProvider(withClock(context.background(), new Clock())),
	};
}

function shouldRun(target: TestEnvironment | "both"): boolean {
	return target === "both" || target === currentTestEnvironment;
}

function isBrowserTestEnvironment(): boolean {
	const globals = globalThis as Record<string, unknown>;
	return typeof globals.window === "object" && globals.window === globalThis;
}
