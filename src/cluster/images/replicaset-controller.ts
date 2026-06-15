import {
	ReplicaSetController as Controller,
	type ReplicaSetControllerFeatures,
	defaultReplicaSetControllerFeatures,
} from "../../controller/replicaset/replica-set";
import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

export {
	calculateStatus,
	defaultReplicaSetControllerFeatures,
	filterOutCondition,
	getCondition,
	getPodKeys,
	getPodsToDelete,
	newReplicaSetCondition,
	removeCondition,
	setCondition,
	slowStartBatch,
} from "../../controller/replicaset/replica-set";
export type { ReplicaSetControllerFeatures } from "../../controller/replicaset/replica-set";

export class ReplicaSetController extends BaseImage {
	static readonly imageName = "webernetes/replicaset-controller";
	static readonly imageVersion = "1.0";

	readonly defaultCommand = ["replicaset-controller"];
	readonly controller: Controller;

	constructor(
		controllerFeatures: ReplicaSetControllerFeatures = defaultReplicaSetControllerFeatures(),
	) {
		super();
		this.controller = new Controller(controllerFeatures);
	}

	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "replicaset-controller") {
			return await super.exec(ctx, argv);
		}
		await this.controller.start(ctx);
		try {
			return await ctx.waitUntilKilled();
		} finally {
			await this.controller.stop();
		}
	}
}
