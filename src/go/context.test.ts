import { expect, it } from "vitest";

import { select } from "./channel";
import * as context from "./context";
import { browser } from "../test/describe";

// These tests mirror the cancel-only subset of Go's context tests from:
// https://github.com/golang/go/blob/go1.26.0/src/context/x_test.go
// https://github.com/golang/go/blob/go1.26.0/src/context/context_test.go
//
// Not mirrored yet:
// - TODO contexts, string formatting, deadlines, timeouts, values, causes,
//   AfterFunc, goroutine allocation tests, and benchmarks.
// - Tests that inspect Go's unexported child maps directly. We verify the
//   observable behavior instead.
browser.describe("Context", () => {
	// Mirrors Go TestBackground, lines 59-71:
	// https://github.com/golang/go/blob/go1.26.0/src/context/x_test.go#L59-L71
	it("background is never canceled", async () => {
		const ctx = context.background();
		expect(ctx).toBeDefined();
		expect(ctx.err()).toBeUndefined();
		await expect(doneIsReady(ctx)).resolves.toBe(false);
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
});

async function doneIsReady(ctx: context.Context): Promise<boolean> {
	return await select()
		.case(ctx.done(), () => true)
		.default(() => false);
}
