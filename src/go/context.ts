import { Channel, type ReadOnlyChannel } from "./channel";

export class ContextError extends Error {}

export const Canceled = new ContextError("context canceled");

export type CancelFunc = () => void;

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

	constructor(private readonly parent: Context) {}

	done(): ReadOnlyChannel<void> {
		return this.doneCh.readOnly();
	}

	err(): ContextError | undefined {
		return this.error;
	}

	addChild(child: CancelContext): void {
		if (this.error) {
			child.cancel(false, this.error);
			return;
		}
		this.children.add(child);
	}

	removeChild(child: CancelContext): void {
		this.children.delete(child);
	}

	cancel(removeFromParent: boolean, error: ContextError): void {
		if (this.error) {
			return;
		}
		this.error = error;
		this.doneCh.close();

		for (const child of this.children) {
			child.cancel(false, error);
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

export function withCancel(parent: Context): [Context, CancelFunc] {
	const context = new CancelContext(parent);
	const parentContext = parentCancelContext(parent);
	if (parent.err()) {
		context.cancel(false, parent.err() as ContextError);
	} else if (parentContext) {
		parentContext.addChild(context);
	}

	return [
		context,
		() => {
			context.cancel(true, Canceled);
		},
	];
}

function parentCancelContext(parent: Context): CancelContext | undefined {
	return parent instanceof CancelContext ? parent : undefined;
}
