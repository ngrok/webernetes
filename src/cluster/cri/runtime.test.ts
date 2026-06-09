import { expect, it } from "vitest";

import * as context from "../../go/context";
import { browser } from "../../test/describe";
import { Cluster } from "../cluster";
import { errCommandTimedOut } from "../cri-client/pkg";
import { ImageRegistry } from "./image";
import { BaseImage } from "../images/base";
import type { ProcessContext } from "./runtime";

class TestImage extends BaseImage {
	static readonly imageName = "example/test";
	static readonly imageVersion = "1.0";
}

class StatefulImage extends BaseImage {
	static readonly imageName = "example/stateful";
	static readonly imageVersion = "1.0";

	override async exec(context: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "count") {
			return await super.exec(context, argv);
		}
		this.count++;
		context.writeStdout(`${this.count}\n`);
		return 0;
	}

	private count = 0;
}

class ExampleImageV1 extends BaseImage {
	static readonly imageName = "example/image";
	static readonly imageVersion = "1.0";
}

class ExampleImageV2 extends BaseImage {
	static readonly imageName = "example/image";
	static readonly imageVersion = "2.0";
}

browser.describe("InProcessRuntimeService images", () => {
	it("lists and removes images through the image registry", async () => {
		const cluster = new Cluster();
		try {
			const runtime = cluster.servers[0].runtime;

			const [images, listErr] = await runtime.listImages(context.background());
			expect(listErr).toBeUndefined();
			expect(images.map((image) => image.id)).toContain("busybox:1.36");

			const removeErr = await runtime.removeImage(context.background(), { image: "busybox:1.36" });
			expect(removeErr).toBeUndefined();
			const removeMissingErr = await runtime.removeImage(context.background(), {
				image: "missing:latest",
			});
			expect(removeMissingErr).toBeUndefined();

			const [imagesAfterRemove, listAfterRemoveErr] = await runtime.listImages(
				context.background(),
			);
			expect(listAfterRemoveErr).toBeUndefined();
			expect(imagesAfterRemove.map((image) => image.id)).not.toContain("busybox:1.36");

			const [imageFsInfo, imageFsInfoErr] = await runtime.imageFsInfo(context.background());
			expect(imageFsInfoErr).toBeUndefined();
			expect(imageFsInfo).toEqual({ imageFilesystems: [], containerFilesystems: [] });
		} finally {
			await cluster.close();
		}
	});

	it("creates a new image instance for each resolved container image", () => {
		const registry = new ImageRegistry();
		registry.register(TestImage);

		const first = registry.create("example/test:latest");
		const second = registry.create("example/test:latest");

		expect(first).toBeInstanceOf(TestImage);
		expect(second).toBeInstanceOf(TestImage);
		expect(first).not.toBe(second);
	});

	it("resolves latest to the newest registered image version", () => {
		const registry = new ImageRegistry();
		registry.register(ExampleImageV1);
		registry.register(ExampleImageV2);

		expect(registry.create("example/image:1.0")).toBeInstanceOf(ExampleImageV1);
		expect(registry.create("example/image:latest")).toBeInstanceOf(ExampleImageV2);
		expect(registry.create("example/image")).toBeInstanceOf(ExampleImageV2);
	});

	it("reuses the container image instance for exec processes", async () => {
		const cluster = new Cluster();
		try {
			cluster.registerImage(StatefulImage);
			const runtime = cluster.servers[0].runtime;
			const ctx = context.background();
			const sandboxConfig = {
				metadata: {
					name: "stateful-pod",
					namespace: "default",
					uid: "stateful-pod",
					attempt: 0,
				},
			};
			const [sandboxId, sandboxErr] = await runtime.runPodSandbox(ctx, sandboxConfig);
			expect(sandboxErr).toBeUndefined();
			const [containerId, containerErr] = await runtime.createContainer(
				ctx,
				sandboxId,
				{
					metadata: { name: "main", attempt: 0 },
					image: { image: "example/stateful:latest" },
					command: ["pause"],
				},
				sandboxConfig,
			);
			expect(containerErr).toBeUndefined();
			expect(await runtime.startContainer(ctx, containerId)).toBeUndefined();

			const [first, firstErr] = await runtime.execSync(ctx, containerId, ["count"]);
			const [second, secondErr] = await runtime.execSync(ctx, containerId, ["count"]);

			expect(firstErr).toBeUndefined();
			expect(secondErr).toBeUndefined();
			expect(first?.stdout).toBe("1\n");
			expect(second?.stdout).toBe("2\n");
		} finally {
			await cluster.close();
		}
	});

	it("returns ErrCommandTimedOut when execSync times out", async () => {
		const cluster = new Cluster();
		cluster.clock.pause();
		try {
			const runtime = cluster.servers[0].runtime;
			const ctx = context.background();
			const sandboxConfig = {
				metadata: {
					name: "timeout-pod",
					namespace: "default",
					uid: "timeout-pod",
					attempt: 0,
				},
			};
			const [sandboxId, sandboxErr] = await runtime.runPodSandbox(ctx, sandboxConfig);
			expect(sandboxErr).toBeUndefined();
			const [containerId, containerErr] = await runtime.createContainer(
				ctx,
				sandboxId,
				{
					metadata: { name: "main", attempt: 0 },
					image: { image: "busybox:1.36" },
				},
				sandboxConfig,
			);
			expect(containerErr).toBeUndefined();

			const execPromise = runtime.execSync(ctx, containerId, ["sleep", "10"], 1);
			await Promise.resolve();
			cluster.clock.step(1000);
			const [response, err] = await execPromise;

			expect(response).toBeUndefined();
			expect(err?.message).toBe("command timed out: command sleep 10 timed out");
			expect((err as (Error & { cause?: unknown }) | undefined)?.cause).toBe(errCommandTimedOut);
		} finally {
			await cluster.close();
		}
	});
});
