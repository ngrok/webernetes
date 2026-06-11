import { Clock } from "./clock";
import * as context from "./go/context";

const key = Symbol("clock");

export function withClock(ctx: context.Context, clock: Clock): context.Context {
	return context.withValue(ctx, key, clock);
}

export function getClock(ctx: context.Context): Clock {
	const clock = ctx.value(key);
	if (clock instanceof Clock) {
		return clock;
	}
	throw new Error("context has no clock");
}
