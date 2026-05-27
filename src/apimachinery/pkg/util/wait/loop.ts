import * as context from "../../../../go/context";
import { select } from "../../../../go/channel";
import type { ConditionWithContextFunc } from "./delay";
import type { Timer } from "./timer";

// Models staging/src/k8s.io/apimachinery/pkg/util/wait/loop.go loopConditionUntilContext.
export async function loopConditionUntilContext(
	ctx: context.Context,
	timer: Timer,
	immediate: boolean,
	sliding: boolean,
	condition: ConditionWithContextFunc,
): Promise<Error | undefined> {
	let timeCh: ReturnType<Timer["c"]> | undefined;
	try {
		if (!sliding) {
			timeCh = timer.c();
		}

		if (immediate) {
			const [ok, err] = await condition(ctx);
			if (err || ok) {
				return err;
			}
		}

		if (sliding) {
			timeCh = timer.c();
		}
		if (!timeCh) {
			throw new Error("timer channel was not initialized");
		}

		for (;;) {
			const selected = await select()
				.case(ctx.done(), () => "done" as const)
				.case(timeCh, () => "time" as const);

			if (selected === "done" || ctx.err()) {
				return ctx.err();
			}

			if (!sliding) {
				timer.next();
			}

			const [ok, err] = await condition(ctx);
			if (err || ok) {
				return err;
			}

			if (sliding) {
				timer.next();
			}
		}
	} finally {
		timer.stop();
	}
}
