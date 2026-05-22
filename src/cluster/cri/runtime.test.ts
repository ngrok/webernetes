import { expect, it } from "vitest";

import * as context from "../../go/context";
import { browser } from "../../test/describe";
import { Cluster } from "../cluster";
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

			const [imagesAfterRemove, listAfterRemoveErr] = await runtime.listImages(
				context.background(),
			);
			expect(listAfterRemoveErr).toBeUndefined();
			expect(imagesAfterRemove.map((image) => image.id)).not.toContain("busybox:1.36");
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
});
