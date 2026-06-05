import type { Clock } from "../../../../clock";
import * as context from "../../../../go/context";
import type { MaybePromise } from "../../../../promise";
import { loopConditionUntilContext } from "./loop";
import { realTimer, type Timer, VariableTimer } from "./timer";

export type ConditionWithContextFunc = (
	ctx: context.Context,
) => MaybePromise<[done: boolean, err: Error | undefined]>;

// Models staging/src/k8s.io/apimachinery/pkg/util/wait/delay.go DelayFunc.
export class DelayFunc {
	constructor(
		private readonly fn: () => number,
		private readonly clock: Clock,
	) {}

	next(): number {
		return this.fn();
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/delay.go DelayFunc.Timer.
	timer(clock: Clock): Timer {
		return new VariableTimer(this, realTimer(clock));
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/delay.go DelayFunc.Until.
	async until(
		ctx: context.Context,
		immediate: boolean,
		sliding: boolean,
		condition: ConditionWithContextFunc,
	): Promise<Error | undefined> {
		return await loopConditionUntilContext(
			ctx,
			this.timer(this.clock),
			immediate,
			sliding,
			condition,
		);
	}

	// Models staging/src/k8s.io/apimachinery/pkg/util/wait/delay.go DelayFunc.Concurrent.
	concurrent(): DelayFunc {
		return new DelayFunc(() => this.next(), this.clock);
	}
}
