import { expect, it } from "vitest";

import * as context from "../../go/context";
import { browser } from "../../test/describe";
import { waitFor } from "../../test/wait";
import { Cluster } from "../cluster";
import { errCommandTimedOut } from "../cri-client/pkg";
import { ImageRegistry, type ImageSignal } from "./image";
import { BaseImage } from "../images/base";
import type { ProcessContext } from "./runtime";
import { newLatencyProvider } from "../../latency";

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

class SlowStopImage extends BaseImage {
	static readonly imageName = "example/slow-stop";
	static readonly imageVersion = "1.0";
	static processContext: ProcessContext | undefined;

	static reset(): void {
		this.processContext = undefined;
	}

	override async exec(context: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "slow-stop") {
			return await super.exec(context, argv);
		}
		SlowStopImage.processContext = context;
		await context.done().receive();
		await new Promise<void>((resolve) => {
			context.clock.setTimeout(resolve, 5000);
		});
		return 0;
	}
}

class IgnoreStopImage extends BaseImage {
	static readonly imageName = "example/ignore-stop";
	static readonly imageVersion = "1.0";

	override async exec(context: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "ignore-stop") {
			return await super.exec(context, argv);
		}
		return await new Promise<number>(() => {});
	}
}

class SignalHandlerImage extends BaseImage {
	static readonly imageName = "example/signal-handler";
	static readonly imageVersion = "1.0";
	static processContext: ProcessContext | undefined;
	static release: (() => void) | undefined;
	static signals: ImageSignal[] = [];

	static reset(): void {
		this.processContext = undefined;
		this.release = undefined;
		this.signals = [];
	}

	override async exec(context: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "handle-signal") {
			return await super.exec(context, argv);
		}
		SignalHandlerImage.processContext = context;
		return await new Promise<number>((resolve) => {
			SignalHandlerImage.release = () => resolve(0);
		});
	}

	signalHandler(context: ProcessContext, signal: ImageSignal): void {
		SignalHandlerImage.signals.push(signal);
		if (signal === "SIGTERM") {
			context.clock.setTimeout(() => SignalHandlerImage.release?.(), 5000);
		}
	}
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
				pod: {
					metadata: {
						name: "stateful-pod",
						namespace: "default",
						uid: "stateful-pod",
					},
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
					sourceContainer: {
						name: "main",
						image: "example/stateful:latest",
						command: ["pause"],
					},
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
				pod: {
					metadata: {
						name: "timeout-pod",
						namespace: "default",
						uid: "timeout-pod",
					},
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
					sourceContainer: { name: "main", image: "busybox:1.36" },
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

	it("keeps a container running while graceful stop waits for the process to exit", async () => {
		const cluster = new Cluster();
		cluster.clock.pause();
		SlowStopImage.reset();
		try {
			cluster.registerImage(SlowStopImage);
			const runtime = cluster.servers[0].runtime;
			const ctx = cluster.ctx;
			const sandboxConfig = {
				metadata: {
					name: "slow-stop-pod",
					namespace: "default",
					uid: "slow-stop-pod",
					attempt: 0,
				},
				pod: {
					metadata: {
						name: "slow-stop-pod",
						namespace: "default",
						uid: "slow-stop-pod",
					},
				},
			};
			const [sandboxId, sandboxErr] = await runtime.runPodSandbox(ctx, sandboxConfig);
			expect(sandboxErr).toBeUndefined();
			const [containerId, containerErr] = await runtime.createContainer(
				ctx,
				sandboxId,
				{
					metadata: { name: "main", attempt: 0 },
					image: { image: "example/slow-stop:latest" },
					command: ["slow-stop"],
					sourceContainer: {
						name: "main",
						image: "example/slow-stop:latest",
						command: ["slow-stop"],
					},
				},
				sandboxConfig,
			);
			expect(containerErr).toBeUndefined();
			expect(await runtime.startContainer(ctx, containerId)).toBeUndefined();

			const stopPromise = runtime.stopContainer(ctx, containerId, 10);
			await Promise.resolve();

			expect(SlowStopImage.processContext?.err()).toBeDefined();
			let [status, statusErr] = await runtime.containerStatus(ctx, containerId);
			expect(statusErr).toBeUndefined();
			expect(status?.status?.state).toBe("Running");

			cluster.clock.step(4999);
			await Promise.resolve();
			[status, statusErr] = await runtime.containerStatus(ctx, containerId);
			expect(statusErr).toBeUndefined();
			expect(status?.status?.state).toBe("Running");

			cluster.clock.step(1);
			expect(await stopPromise).toBeUndefined();
			[status, statusErr] = await runtime.containerStatus(ctx, containerId);
			expect(statusErr).toBeUndefined();
			expect(status?.status?.state).toBe("Exited");
		} finally {
			await cluster.close();
		}
	});

	it("lets image signal handlers handle SIGTERM without canceling the process context", async () => {
		const cluster = new Cluster();
		cluster.clock.pause();
		SignalHandlerImage.reset();
		try {
			cluster.registerImage(SignalHandlerImage);
			const runtime = cluster.servers[0].runtime;
			const ctx = cluster.ctx;
			const sandboxConfig = {
				metadata: {
					name: "signal-handler-pod",
					namespace: "default",
					uid: "signal-handler-pod",
					attempt: 0,
				},
				pod: {
					metadata: {
						name: "signal-handler-pod",
						namespace: "default",
						uid: "signal-handler-pod",
					},
				},
			};
			const [sandboxId, sandboxErr] = await runtime.runPodSandbox(ctx, sandboxConfig);
			expect(sandboxErr).toBeUndefined();
			const [containerId, containerErr] = await runtime.createContainer(
				ctx,
				sandboxId,
				{
					metadata: { name: "main", attempt: 0 },
					image: { image: "example/signal-handler:latest" },
					command: ["handle-signal"],
					sourceContainer: {
						name: "main",
						image: "example/signal-handler:latest",
						command: ["handle-signal"],
					},
				},
				sandboxConfig,
			);
			expect(containerErr).toBeUndefined();
			expect(await runtime.startContainer(ctx, containerId)).toBeUndefined();

			const stopPromise = runtime.stopContainer(ctx, containerId, 10);
			await Promise.resolve();

			expect(SignalHandlerImage.signals).toEqual(["SIGTERM"]);
			expect(SignalHandlerImage.processContext?.err()).toBeUndefined();
			let [status, statusErr] = await runtime.containerStatus(ctx, containerId);
			expect(statusErr).toBeUndefined();
			expect(status?.status?.state).toBe("Running");

			cluster.clock.step(4999);
			await Promise.resolve();
			[status, statusErr] = await runtime.containerStatus(ctx, containerId);
			expect(statusErr).toBeUndefined();
			expect(status?.status?.state).toBe("Running");

			cluster.clock.step(1);
			expect(await stopPromise).toBeUndefined();
			[status, statusErr] = await runtime.containerStatus(ctx, containerId);
			expect(statusErr).toBeUndefined();
			expect(status?.status?.state).toBe("Exited");
		} finally {
			await cluster.close();
		}
	});

	it("calls image signal handlers before force killing with SIGKILL", async () => {
		const cluster = new Cluster();
		cluster.clock.pause();
		SignalHandlerImage.reset();
		try {
			cluster.registerImage(SignalHandlerImage);
			const runtime = cluster.servers[0].runtime;
			const ctx = cluster.ctx;
			const sandboxConfig = {
				metadata: {
					name: "signal-kill-pod",
					namespace: "default",
					uid: "signal-kill-pod",
					attempt: 0,
				},
				pod: {
					metadata: {
						name: "signal-kill-pod",
						namespace: "default",
						uid: "signal-kill-pod",
					},
				},
			};
			const [sandboxId, sandboxErr] = await runtime.runPodSandbox(ctx, sandboxConfig);
			expect(sandboxErr).toBeUndefined();
			const [containerId, containerErr] = await runtime.createContainer(
				ctx,
				sandboxId,
				{
					metadata: { name: "main", attempt: 0 },
					image: { image: "example/signal-handler:latest" },
					command: ["handle-signal"],
					sourceContainer: {
						name: "main",
						image: "example/signal-handler:latest",
						command: ["handle-signal"],
					},
				},
				sandboxConfig,
			);
			expect(containerErr).toBeUndefined();
			expect(await runtime.startContainer(ctx, containerId)).toBeUndefined();

			const stopPromise = runtime.stopContainer(ctx, containerId, 2);
			await Promise.resolve();
			expect(SignalHandlerImage.signals).toEqual(["SIGTERM"]);
			expect(SignalHandlerImage.processContext?.err()).toBeUndefined();
			await waitFor(() => expect(cluster.clock.pendingTaskCount()).toBe(2));

			cluster.clock.step(2000);
			expect(await stopPromise).toBeUndefined();
			expect(SignalHandlerImage.signals).toEqual(["SIGTERM", "SIGKILL"]);
			expect(SignalHandlerImage.processContext?.err()).toBeDefined();
			const [status, statusErr] = await runtime.containerStatus(ctx, containerId);
			expect(statusErr).toBeUndefined();
			expect(status?.status?.state).toBe("Exited");
		} finally {
			await cluster.close();
		}
	});

	it("force kills a container when graceful stop exceeds the timeout", async () => {
		const cluster = new Cluster();
		cluster.clock.pause();
		try {
			cluster.registerImage(IgnoreStopImage);
			const runtime = cluster.servers[0].runtime;
			const ctx = cluster.ctx;
			const sandboxConfig = {
				metadata: {
					name: "ignore-stop-pod",
					namespace: "default",
					uid: "ignore-stop-pod",
					attempt: 0,
				},
				pod: {
					metadata: {
						name: "ignore-stop-pod",
						namespace: "default",
						uid: "ignore-stop-pod",
					},
				},
			};
			const [sandboxId, sandboxErr] = await runtime.runPodSandbox(ctx, sandboxConfig);
			expect(sandboxErr).toBeUndefined();
			const [containerId, containerErr] = await runtime.createContainer(
				ctx,
				sandboxId,
				{
					metadata: { name: "main", attempt: 0 },
					image: { image: "example/ignore-stop:latest" },
					command: ["ignore-stop"],
					sourceContainer: {
						name: "main",
						image: "example/ignore-stop:latest",
						command: ["ignore-stop"],
					},
				},
				sandboxConfig,
			);
			expect(containerErr).toBeUndefined();
			expect(await runtime.startContainer(ctx, containerId)).toBeUndefined();

			const stopPromise = runtime.stopContainer(ctx, containerId, 2);
			await Promise.resolve();
			cluster.clock.step(1999);
			await Promise.resolve();

			let [status, statusErr] = await runtime.containerStatus(ctx, containerId);
			expect(statusErr).toBeUndefined();
			expect(status?.status?.state).toBe("Running");

			cluster.clock.step(1);
			expect(await stopPromise).toBeUndefined();
			[status, statusErr] = await runtime.containerStatus(ctx, containerId);
			expect(statusErr).toBeUndefined();
			expect(status?.status?.state).toBe("Exited");
		} finally {
			await cluster.close();
		}
	});

	it("waits for configured container termination latency before stopping the process", async () => {
		const terminationEvents: string[] = [];
		const sourceContainer = { name: "main", image: "busybox:1.36" };
		const cluster = new Cluster({
			latencyProvider: newLatencyProvider({
				containerTerminationLatency: (event) => {
					terminationEvents.push(event.container.name);
					expect(event.container).toBe(sourceContainer);
					expect(event.container.image).toBe("busybox:1.36");
					return 5000;
				},
			}),
		});
		cluster.clock.pause();
		try {
			const runtime = cluster.servers[0].runtime;
			const sandboxConfig = {
				metadata: {
					name: "latency-stop-pod",
					namespace: "default",
					uid: "latency-stop-pod",
					attempt: 0,
				},
				pod: {
					metadata: {
						name: "latency-stop-pod",
						namespace: "default",
						uid: "latency-stop-pod",
					},
				},
			};
			const [sandboxId, sandboxErr] = await runtime.runPodSandbox(cluster.ctx, sandboxConfig);
			expect(sandboxErr).toBeUndefined();
			const [containerId, containerErr] = await runtime.createContainer(
				cluster.ctx,
				sandboxId,
				{
					metadata: { name: "main", attempt: 0 },
					image: { image: "busybox:1.36" },
					command: ["pause"],
					sourceContainer,
				},
				sandboxConfig,
			);
			expect(containerErr).toBeUndefined();
			expect(await runtime.startContainer(cluster.ctx, containerId)).toBeUndefined();

			const stopPromise = runtime.stopContainer(cluster.ctx, containerId, 10);
			await Promise.resolve();
			expect(terminationEvents).toEqual(["main"]);

			let [status, statusErr] = await runtime.containerStatus(cluster.ctx, containerId);
			expect(statusErr).toBeUndefined();
			expect(status?.status?.state).toBe("Running");

			cluster.clock.step(4999);
			await Promise.resolve();
			[status, statusErr] = await runtime.containerStatus(cluster.ctx, containerId);
			expect(statusErr).toBeUndefined();
			expect(status?.status?.state).toBe("Running");

			cluster.clock.step(1);
			expect(await stopPromise).toBeUndefined();
			[status, statusErr] = await runtime.containerStatus(cluster.ctx, containerId);
			expect(statusErr).toBeUndefined();
			expect(status?.status?.state).toBe("Exited");
		} finally {
			await cluster.close();
		}
	});
});
