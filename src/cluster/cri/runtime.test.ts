import { expect, it } from "vitest";

import * as context from "../../go/context";
import { browser } from "../../test/describe";
import { Cluster } from "../cluster";
import { errCommandTimedOut } from "../cri-client/pkg";
import { ImageRegistry } from "./image";
import { BaseImage } from "../images/base";

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
		registry.register("example/image:latest", () => new BaseImage());

		const first = registry.create("example/image:latest");
		const second = registry.create("example/image:latest");

		expect(first).toBeInstanceOf(BaseImage);
		expect(second).toBeInstanceOf(BaseImage);
		expect(first).not.toBe(second);
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
