import { expect, it } from "vitest";

import { getClock } from "../clock-context";
import { select } from "./channel";
import * as context from "./context";
import { browser } from "../test/describe";

// These tests mirror the cancel-only subset of Go's context tests from:
// https://github.com/golang/go/blob/go1.26.0/src/context/x_test.go
// https://github.com/golang/go/blob/go1.26.0/src/context/context_test.go
//
// Not mirrored yet:
// - TODO contexts, string formatting, deadlines, values, WithoutCancel, custom
//   contexts, AfterFunc, goroutine allocation tests, and benchmarks.
// - Tests that inspect Go's unexported child maps directly. We verify the
//   observable behavior instead.
browser.describe("Context", ({ ctx }) => {
	// Mirrors Go TestBackground, lines 59-71:
	// https://github.com/golang/go/blob/go1.26.0/src/context/x_test.go#L59-L71
	it("background is never canceled", async () => {
		const ctx = context.background();
		expect(ctx).toBeDefined();
		expect(ctx.err()).toBeUndefined();
		expect(ctx.value("missing")).toBeUndefined();
		await expect(doneIsReady(ctx)).resolves.toBe(false);
	});

	// Mirrors the observable lookup behavior from Go TestValues, lines 209-267:
	// https://github.com/golang/go/blob/go1.26.0/src/context/x_test.go#L209-L267
	it("withValue resolves values from the nearest matching key", () => {
		const key1 = Symbol("key1");
		const key2 = Symbol("key2");
		const key3 = {};

		const c0 = context.background();
		expect(c0.value(key1)).toBeUndefined();

		const c1 = context.withValue(c0, key1, "c1k1");
		expect(c1.value(key1)).toBe("c1k1");
		expect(c1.value(key2)).toBeUndefined();

		const c2 = context.withValue(c1, key2, "c2k2");
		expect(c2.value(key1)).toBe("c1k1");
		expect(c2.value(key2)).toBe("c2k2");
		expect(c2.value(key3)).toBeUndefined();

		const c3 = context.withValue(c2, key3, "c3k3");
		const c4 = context.withValue(c3, key1, undefined);
		expect(c4.value(key1)).toBeUndefined();
		expect(c4.value(key2)).toBe("c2k2");
		expect(c4.value(key3)).toBe("c3k3");
	});

	// Mirrors Go TestWithValueChecksKey, lines 538-547:
	// https://github.com/golang/go/blob/go1.26.0/src/context/x_test.go#L538-L547
	it("withValue rejects invalid keys", () => {
		expect(() => context.withValue(context.background(), ["foo"], "bar")).toThrow(
			"key is not comparable",
		);
		expect(() => context.withValue(context.background(), undefined, "bar")).toThrow("nil key");
		expect(() => context.withValue(context.background(), null, "bar")).toThrow("nil key");
	});

	// Mirrors Go TestInvalidDerivedFail's WithValue nil-parent case, lines 558-561:
	// https://github.com/golang/go/blob/go1.26.0/src/context/x_test.go#L558-L561
	it("withValue rejects a missing parent", () => {
		expect(() => context.withValue(null as unknown as context.Context, "foo", "bar")).toThrow(
			"cannot create context from nil parent",
		);
	});

	// Mirrors Go TestWithCancel, lines 89-124:
	// https://github.com/golang/go/blob/go1.26.0/src/context/x_test.go#L89-L124
	it("withCancel closes done and sets err synchronously", async () => {
		const [ctx, cancel] = context.withCancel(context.background());

		expect(ctx.done()).toBeDefined();
		expect(ctx.err()).toBeUndefined();
		await expect(doneIsReady(ctx)).resolves.toBe(false);

		cancel();

		await expect(doneIsReady(ctx)).resolves.toBe(true);
		expect(ctx.err()).toBe(context.Canceled);
	});

	// Derived from this Go program:
	//
	// package main
	//
	// import (
	// 	"context"
	// 	"fmt"
	// 	"sync"
	// 	"sync/atomic"
	// )
	//
	// func main() {
	// 	ctx, cancel := context.WithCancel(context.Background())
	// 	var wg sync.WaitGroup
	// 	var unblocked int32
	// 	for range 6 {
	// 		wg.Add(1)
	// 		go func() {
	// 			defer wg.Done()
	// 			<-ctx.Done()
	// 			atomic.AddInt32(&unblocked, 1)
	// 		}()
	// 	}
	// 	cancel()
	// 	wg.Wait()
	// 	fmt.Println(unblocked)
	// }
	//
	// Output:
	// 6
	it("canceling a context unblocks all waiters on done", async () => {
		const [ctx, cancel] = context.withCancel(context.background());
		const receiveWaiters = Array.from({ length: 3 }, async () => {
			const result = await ctx.done().receive();
			return result.ok;
		});
		const selectWaiters = Array.from({ length: 3 }, () =>
			select()
				.case(ctx.done(), (result) => result.ok)
				.then((ok) => ok),
		);

		await expect(doneIsReady(ctx)).resolves.toBe(false);

		cancel();

		await expect(Promise.all([...receiveWaiters, ...selectWaiters])).resolves.toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
		]);
		expect(ctx.err()).toBe(context.Canceled);
	});

	// Mirrors Go XTestParentFinishesChild, lines 35-129:
	// https://github.com/golang/go/blob/go1.26.0/src/context/context_test.go#L35-L129
	it("canceling a parent cancels children synchronously", async () => {
		const [parent, cancelParent] = context.withCancel(context.background());
		const [child, cancelChild] = context.withCancel(parent);
		const [grandchild, cancelGrandchild] = context.withCancel(child);

		try {
			await expect(doneIsReady(parent)).resolves.toBe(false);
			await expect(doneIsReady(child)).resolves.toBe(false);
			await expect(doneIsReady(grandchild)).resolves.toBe(false);

			cancelParent();

			await expect(doneIsReady(parent)).resolves.toBe(true);
			await expect(doneIsReady(child)).resolves.toBe(true);
			await expect(doneIsReady(grandchild)).resolves.toBe(true);
			expect(parent.err()).toBe(context.Canceled);
			expect(child.err()).toBe(context.Canceled);
			expect(grandchild.err()).toBe(context.Canceled);
		} finally {
			cancelGrandchild();
			cancelChild();
		}
	});

	// Mirrors Go XTestParentFinishesChild's pre-canceled child check, lines 121-129:
	// https://github.com/golang/go/blob/go1.26.0/src/context/context_test.go#L121-L129
	it("creates an already-canceled child from an already-canceled parent", async () => {
		const [parent, cancelParent] = context.withCancel(context.background());
		cancelParent();

		const [child, cancelChild] = context.withCancel(parent);
		try {
			await expect(doneIsReady(child)).resolves.toBe(true);
			expect(child.err()).toBe(context.Canceled);
		} finally {
			cancelChild();
		}
	});

	// Mirrors Go XTestChildFinishesFirst, lines 131-189:
	// https://github.com/golang/go/blob/go1.26.0/src/context/context_test.go#L131-L189
	it("canceling a child does not cancel the parent", async () => {
		const [parent, cancelParent] = context.withCancel(context.background());
		const [child, cancelChild] = context.withCancel(parent);

		try {
			await expect(doneIsReady(parent)).resolves.toBe(false);
			await expect(doneIsReady(child)).resolves.toBe(false);

			cancelChild();

			await expect(doneIsReady(child)).resolves.toBe(true);
			expect(child.err()).toBe(context.Canceled);
			await expect(doneIsReady(parent)).resolves.toBe(false);
			expect(parent.err()).toBeUndefined();
		} finally {
			cancelParent();
		}
	});

	// Mirrors Go XTestChildFinishesFirst and XTestCancelRemoves observable behavior:
	// a child that canceled first should not be retained and re-canceled by parent.
	it("cancel is idempotent after child and parent cancellation", async () => {
		const [parent, cancelParent] = context.withCancel(context.background());
		const [child, cancelChild] = context.withCancel(parent);

		cancelChild();
		cancelChild();
		cancelParent();
		cancelParent();

		await expect(doneIsReady(parent)).resolves.toBe(true);
		await expect(doneIsReady(child)).resolves.toBe(true);
		expect(parent.err()).toBe(context.Canceled);
		expect(child.err()).toBe(context.Canceled);
	});

	// Mirrors Go TestTimeout's observable deadline behavior, lines 171-184:
	// https://github.com/golang/go/blob/go1.26.0/src/context/x_test.go#L171-L184
	it("withTimeout closes done with DeadlineExceeded after the timeout", async () => {
		const clock = getClock(ctx);
		clock.pause();
		const [timeoutCtx, cancel] = context.withTimeout(ctx, 1000);

		try {
			await expect(doneIsReady(timeoutCtx)).resolves.toBe(false);

			clock.step(1000);

			await expect(doneIsReady(timeoutCtx)).resolves.toBe(true);
			expect(timeoutCtx.err()).toBe(context.DeadlineExceeded);
			expect(context.cause(timeoutCtx)).toBe(context.DeadlineExceeded);
		} finally {
			cancel();
		}
	});

	// Mirrors Go TestCanceledTimeout, lines 188-199:
	// https://github.com/golang/go/blob/go1.26.0/src/context/x_test.go#L188-L199
	it("canceling withTimeout propagates synchronously as Canceled", async () => {
		const clock = getClock(ctx);
		clock.pause();
		const [parent] = context.withTimeout(ctx, 1000);
		const [child, cancel] = context.withTimeout(parent, 60 * 60 * 1000);

		cancel();

		await expect(doneIsReady(child)).resolves.toBe(true);
		expect(child.err()).toBe(context.Canceled);
		expect(context.cause(child)).toBe(context.Canceled);

		clock.step(60 * 60 * 1000);

		expect(child.err()).toBe(context.Canceled);
		expect(context.cause(child)).toBe(context.Canceled);
	});

	// Mirrors Go XTestParentFinishesChild timer-child behavior, lines 45-52 and 94-119:
	// https://github.com/golang/go/blob/go1.26.0/src/context/context_test.go#L45-L52
	it("canceling a parent cancels timeout children synchronously", async () => {
		const clock = getClock(ctx);
		clock.pause();
		const [parent, cancelParent] = context.withCancel(ctx);
		const [timerChild, stop] = context.withTimeout(parent, 60 * 60 * 1000);

		try {
			await expect(doneIsReady(parent)).resolves.toBe(false);
			await expect(doneIsReady(timerChild)).resolves.toBe(false);

			cancelParent();

			await expect(doneIsReady(parent)).resolves.toBe(true);
			await expect(doneIsReady(timerChild)).resolves.toBe(true);
			expect(parent.err()).toBe(context.Canceled);
			expect(timerChild.err()).toBe(context.Canceled);
		} finally {
			stop();
		}
	});

	// Mirrors Go XTestParentFinishesChild's parent -> valueChild -> timerChild tree,
	// lines 45-52 and 94-119:
	// https://github.com/golang/go/blob/go1.26.0/src/context/context_test.go#L45-L52
	it("canceling a parent cancels timeout children through value contexts", async () => {
		const clock = getClock(ctx);
		clock.pause();
		const [parent, cancelParent] = context.withCancel(ctx);
		const valueChild = context.withValue(parent, "key", "value");
		const [timerChild, stop] = context.withTimeout(valueChild, 60 * 60 * 1000);

		try {
			await expect(doneIsReady(parent)).resolves.toBe(false);
			await expect(doneIsReady(valueChild)).resolves.toBe(false);
			await expect(doneIsReady(timerChild)).resolves.toBe(false);

			cancelParent();

			await expect(doneIsReady(parent)).resolves.toBe(true);
			await expect(doneIsReady(valueChild)).resolves.toBe(true);
			await expect(doneIsReady(timerChild)).resolves.toBe(true);
			expect(parent.err()).toBe(context.Canceled);
			expect(valueChild.err()).toBe(context.Canceled);
			expect(timerChild.err()).toBe(context.Canceled);
			expect(valueChild.value("key")).toBe("value");
		} finally {
			stop();
		}
	});

	it("timeout child expiration does not cancel the parent", async () => {
		const clock = getClock(ctx);
		clock.pause();
		const [parent, cancelParent] = context.withCancel(ctx);
		const [child, cancelChild] = context.withTimeout(parent, 1000);

		try {
			clock.step(1000);

			await expect(doneIsReady(child)).resolves.toBe(true);
			expect(child.err()).toBe(context.DeadlineExceeded);
			await expect(doneIsReady(parent)).resolves.toBe(false);
			expect(parent.err()).toBeUndefined();
		} finally {
			cancelChild();
			cancelParent();
		}
	});

	// Mirrors Go TestWithCancelCanceledParent, lines 501-518:
	// https://github.com/golang/go/blob/go1.26.0/src/context/x_test.go#L501-L518
	it("inherits the cause from an already-canceled parent", async () => {
		const [parent, cancelParent] = context.withCancelCause(context.background());
		const expectedCause = new Error("Because!");
		cancelParent(expectedCause);

		const [child] = context.withCancel(parent);

		await expect(doneIsReady(child)).resolves.toBe(true);
		expect(child.err()).toBe(context.Canceled);
		expect(context.cause(child)).toBe(expectedCause);
	});

	// Mirrors the cancel-only cases from Go TestCause, lines 581-712:
	// https://github.com/golang/go/blob/go1.26.0/src/context/x_test.go#L581-L712
	it("reports cancellation causes", () => {
		const parentCause = new Error("parentCause");
		const childCause = new Error("childCause");
		const tests: Array<{
			name: string;
			ctx: () => context.Context;
			err: Error | undefined;
			cause: Error | undefined;
		}> = [
			{
				name: "Background",
				ctx: context.background,
				err: undefined,
				cause: undefined,
			},
			{
				name: "WithCancel",
				ctx: () => {
					const [ctx, cancel] = context.withCancel(context.background());
					cancel();
					return ctx;
				},
				err: context.Canceled,
				cause: context.Canceled,
			},
			{
				name: "WithCancelCause",
				ctx: () => {
					const [ctx, cancel] = context.withCancelCause(context.background());
					cancel(parentCause);
					return ctx;
				},
				err: context.Canceled,
				cause: parentCause,
			},
			{
				name: "WithCancelCause nil",
				ctx: () => {
					const [ctx, cancel] = context.withCancelCause(context.background());
					cancel(undefined);
					return ctx;
				},
				err: context.Canceled,
				cause: context.Canceled,
			},
			{
				name: "WithCancelCause: parent cause before child",
				ctx: () => {
					let [ctx, cancelParent] = context.withCancelCause(context.background());
					const [child, cancelChild] = context.withCancelCause(ctx);
					ctx = child;
					cancelParent(parentCause);
					cancelChild(childCause);
					return ctx;
				},
				err: context.Canceled,
				cause: parentCause,
			},
			{
				name: "WithCancelCause: parent cause after child",
				ctx: () => {
					let [ctx, cancelParent] = context.withCancelCause(context.background());
					const [child, cancelChild] = context.withCancelCause(ctx);
					ctx = child;
					cancelChild(childCause);
					cancelParent(parentCause);
					return ctx;
				},
				err: context.Canceled,
				cause: childCause,
			},
			{
				name: "WithCancelCause: parent cause before nil",
				ctx: () => {
					let [ctx, cancelParent] = context.withCancelCause(context.background());
					const [child, cancelChild] = context.withCancel(ctx);
					ctx = child;
					cancelParent(parentCause);
					cancelChild();
					return ctx;
				},
				err: context.Canceled,
				cause: parentCause,
			},
			{
				name: "WithCancelCause: parent cause after nil",
				ctx: () => {
					let [ctx, cancelParent] = context.withCancelCause(context.background());
					const [child, cancelChild] = context.withCancel(ctx);
					ctx = child;
					cancelChild();
					cancelParent(parentCause);
					return ctx;
				},
				err: context.Canceled,
				cause: context.Canceled,
			},
			{
				name: "WithCancelCause: child cause after nil",
				ctx: () => {
					let [ctx, cancelParent] = context.withCancel(context.background());
					const [child, cancelChild] = context.withCancelCause(ctx);
					ctx = child;
					cancelParent();
					cancelChild(childCause);
					return ctx;
				},
				err: context.Canceled,
				cause: context.Canceled,
			},
			{
				name: "WithCancelCause: child cause before nil",
				ctx: () => {
					let [ctx, cancelParent] = context.withCancel(context.background());
					const [child, cancelChild] = context.withCancelCause(ctx);
					ctx = child;
					cancelChild(childCause);
					cancelParent();
					return ctx;
				},
				err: context.Canceled,
				cause: childCause,
			},
			{
				name: "WithTimeout",
				ctx: () => {
					const [timeoutCtx, cancel] = context.withTimeout(ctx, 0);
					cancel();
					return timeoutCtx;
				},
				err: context.DeadlineExceeded,
				cause: context.DeadlineExceeded,
			},
			{
				name: "WithTimeout canceled",
				ctx: () => {
					const [timeoutCtx, cancel] = context.withTimeout(ctx, 60 * 60 * 1000);
					cancel();
					return timeoutCtx;
				},
				err: context.Canceled,
				cause: context.Canceled,
			},
		];

		for (const test of tests) {
			const gotCtx = test.ctx();
			expect(gotCtx.err()).toBe(test.err);
			expect(context.cause(gotCtx)).toBe(test.cause);
		}
	});
});

async function doneIsReady(ctx: context.Context): Promise<boolean> {
	return await select()
		.case(ctx.done(), () => true)
		.default(() => false);
}
