/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { Channel, type ReadOnlyChannel } from "./channel";
import { Clock } from "../clock";

export class ContextError extends Error {}

export const Canceled = new ContextError("context canceled");
export const DeadlineExceeded = new ContextError("context deadline exceeded");

export type CancelFunc = () => void;
export type CancelCauseFunc = (cause?: Error | undefined) => void;

export interface Context {
	done(): ReadOnlyChannel<void>;
	err(): ContextError | undefined;
}

class BackgroundContext implements Context {
	private readonly doneCh = new Channel<void>();

	done(): ReadOnlyChannel<void> {
		return this.doneCh.readOnly();
	}

	err(): ContextError | undefined {
		return undefined;
	}
}

class CancelContext implements Context {
	private readonly doneCh = new Channel<void>();
	private readonly children = new Set<CancelContext>();
	private error: ContextError | undefined;
	private causeError: Error | undefined;
	private cleanup: (() => void) | undefined;

	constructor(private readonly parent: Context) {}

	done(): ReadOnlyChannel<void> {
		return this.doneCh.readOnly();
	}

	err(): ContextError | undefined {
		return this.error;
	}

	cause(): Error | undefined {
		return this.causeError;
	}

	addChild(child: CancelContext): void {
		if (this.error) {
			child.cancel(false, this.error, this.causeError);
			return;
		}
		this.children.add(child);
	}

	removeChild(child: CancelContext): void {
		this.children.delete(child);
	}

	setCleanup(cleanup: () => void): void {
		this.cleanup = cleanup;
	}

	cancel(removeFromParent: boolean, error: ContextError, cause?: Error | undefined): void {
		if (this.error) {
			return;
		}
		this.error = error;
		this.causeError = cause ?? error;
		this.cleanup?.();
		this.cleanup = undefined;
		this.doneCh.close();

		for (const child of this.children) {
			child.cancel(false, error, this.causeError);
		}
		this.children.clear();

		if (removeFromParent) {
			parentCancelContext(this.parent)?.removeChild(this);
		}
	}
}

const backgroundContext = new BackgroundContext();

export function background(): Context {
	return backgroundContext;
}

export function cause(ctx: Context): Error | undefined {
	const err = ctx.err();
	if (!err) {
		return undefined;
	}
	const cancelContext = parentCancelContext(ctx);
	return cancelContext?.cause() ?? err;
}

export function withCancel(parent: Context): [Context, CancelFunc] {
	const context = newCancelContext(parent);

	return [
		context,
		() => {
			context.cancel(true, Canceled);
		},
	];
}

export function withCancelCause(parent: Context): [Context, CancelCauseFunc] {
	const context = newCancelContext(parent);

	return [
		context,
		(cause) => {
			context.cancel(true, Canceled, cause);
		},
	];
}

// Models go/src/context/context.go WithTimeout.
export function withTimeout(
	parent: Context,
	timeoutMs: number,
	clock = new Clock(),
): [Context, CancelFunc] {
	const context = newCancelContext(parent);
	const cancel = () => {
		context.cancel(true, Canceled);
	};
	if (context.err()) {
		return [context, cancel];
	}
	if (timeoutMs <= 0) {
		context.cancel(true, DeadlineExceeded);
		return [context, cancel];
	}
	const timer = clock.setTimeout(() => {
		context.cancel(true, DeadlineExceeded);
	}, timeoutMs);
	context.setCleanup(() => {
		clock.clearTimeout(timer);
	});

	return [context, cancel];
}

function newCancelContext(parent: Context): CancelContext {
	const context = new CancelContext(parent);
	const parentContext = parentCancelContext(parent);
	if (parent.err()) {
		context.cancel(false, parent.err() as ContextError, cause(parent));
	} else if (parentContext) {
		parentContext.addChild(context);
	}
	return context;
}

function parentCancelContext(parent: Context): CancelContext | undefined {
	return parent instanceof CancelContext ? parent : undefined;
}
