/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { MaybePromise } from "../../promise";

// Models Go src/sync/once.go Once.
export class Once {
	private done = false;
	private running: Promise<void> | undefined;

	// Models Go src/sync/once.go Once.Do.
	do(f: () => MaybePromise<void>): MaybePromise<void> {
		if (this.done) {
			return;
		}
		if (this.running) {
			return this.running;
		}

		try {
			const result = f();
			if (result instanceof Promise) {
				this.running = result.finally(() => {
					this.done = true;
					this.running = undefined;
				});
				return this.running;
			}
			this.done = true;
		} catch (error) {
			this.done = true;
			throw error;
		}
	}
}
