import { spawn } from "node:child_process";
import { appendFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { K3sContainer, type StartedK3sContainer } from "@testcontainers/k3s";

let containerPromise: Promise<StartedK3sContainer> | undefined;

export const K3S_IMAGE = "rancher/k3s:v1.36.1-k3s1";
export const K3S_CONTAINER_NAME = "k8s-web-simulator-k3s-1-36";
export const K3S_SETUP_TIMEOUT_MS = 180_000;

export const K3S_START_LOCK_DIR = join(tmpdir(), `${K3S_CONTAINER_NAME}.lock`);
export const K3S_SETUP_MARKER_ROOT = join(tmpdir(), `${K3S_CONTAINER_NAME}.ready`);
const K3S_START_LOCK_STALE_MS = 5 * 60 * 1000;
const K3S_START_LOCK_WAIT_MS = 250;
const MANIFEST_INSPECT_TIMEOUT_MS = 5_000;
export const K3S_PULL_LOG_DIR = join(tmpdir(), `${K3S_CONTAINER_NAME}.pulls`);

const WARMUP_IMAGES = [
	"registry.k8s.io/pause:3.10",
	"registry.k8s.io/e2e-test-images/agnhost:2.40",
	"busybox:1.36",
	"hashicorp/http-echo:1.0",
	"crccheck/hello-world:latest",
];

export interface K3sSetupProgress {
	info(message: string): void;
	waitingForLock(path: string): void;
	removedStaleLock(path: string): void;
	imageStart(index: number, total: number, image: string): void;
	imageProgress(index: number, total: number, image: string, status: ImagePullStatus): void;
	imageDone(index: number, total: number, image: string): void;
	imageFallback(index: number, total: number, image: string): void;
	complete(): void;
}

export interface ImagePullStatus {
	downloadedBytes?: number;
	totalBytes?: number;
	rateBytesPerSecond?: number;
	message?: string;
}

export interface K3sSetupOptions {
	progress?: K3sSetupProgress;
}

const silentProgress: K3sSetupProgress = {
	info() {},
	waitingForLock() {},
	removedStaleLock() {},
	imageStart() {},
	imageProgress() {},
	imageDone() {},
	imageFallback() {},
	complete() {},
};

export async function setupK3sInfrastructure(
	options: K3sSetupOptions = {},
): Promise<StartedK3sContainer> {
	const progress = options.progress ?? silentProgress;
	const container = await getK3sContainer(progress);
	await ensureK3sReady(container, progress);
	progress.complete();
	return container;
}

export async function getK3sContainer(
	progress: K3sSetupProgress = silentProgress,
): Promise<StartedK3sContainer> {
	containerPromise ??= withK3sStartupLock(async () => {
		const isRunning = await isK3sContainerRunning();
		progress.info(`${isRunning ? "reusing" : "starting"} ${K3S_IMAGE}`);
		return await new K3sContainer(K3S_IMAGE)
			.withName(K3S_CONTAINER_NAME)
			.withCommand(["server", "--disable=traefik", "--disable=metrics-server"])
			.withReuse()
			.start();
	}, progress);
	return await containerPromise;
}

async function ensureK3sReady(
	container: StartedK3sContainer,
	progress: K3sSetupProgress,
): Promise<void> {
	await withK3sStartupLock(async () => {
		const setupMarkerDir = k3sSetupMarkerDir(container);
		if (await isK3sReady(setupMarkerDir)) {
			progress.info("k3s warmup already complete");
			return;
		}
		progress.info("waiting for node readiness");
		await waitForK3sNodeReady(container);
		await warmK3sImages(container, progress);
		await mkdir(setupMarkerDir, { recursive: true });
	}, progress);
}

async function withK3sStartupLock<T>(
	callback: () => Promise<T>,
	progress: K3sSetupProgress,
): Promise<T> {
	let waitAttempts = 0;
	while (!(await tryAcquireK3sStartupLock(progress))) {
		if (waitAttempts === 0 || waitAttempts % 20 === 0) {
			progress.waitingForLock(K3S_START_LOCK_DIR);
		}
		waitAttempts++;
		await setTimeout(K3S_START_LOCK_WAIT_MS);
	}

	try {
		return await callback();
	} finally {
		await rm(K3S_START_LOCK_DIR, { force: true, recursive: true });
	}
}

async function tryAcquireK3sStartupLock(progress: K3sSetupProgress): Promise<boolean> {
	try {
		await mkdir(K3S_START_LOCK_DIR);
		return true;
	} catch (error) {
		if (!isFileExistsError(error)) {
			throw error;
		}
	}

	const lockStat = await stat(K3S_START_LOCK_DIR).catch(() => undefined);
	if (
		lockStat &&
		Date.now() - lockStat.mtimeMs > K3S_START_LOCK_STALE_MS &&
		(await removeStaleK3sStartupLock())
	) {
		progress.removedStaleLock(K3S_START_LOCK_DIR);
		return await tryAcquireK3sStartupLock(progress);
	}
	return false;
}

async function removeStaleK3sStartupLock(): Promise<boolean> {
	try {
		await rm(K3S_START_LOCK_DIR, { force: true, recursive: true });
		return true;
	} catch {
		return false;
	}
}

async function isK3sReady(setupMarkerDir: string): Promise<boolean> {
	return Boolean(await stat(setupMarkerDir).catch(() => undefined));
}

function k3sSetupMarkerDir(container: StartedK3sContainer): string {
	return join(K3S_SETUP_MARKER_ROOT, container.getId());
}

async function waitForK3sNodeReady(container: StartedK3sContainer): Promise<void> {
	const result = await container.exec([
		"kubectl",
		"wait",
		"--for=condition=Ready",
		"node",
		"--all",
		"--timeout=60s",
	]);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr || result.output || "Timed out waiting for k3s node readiness");
	}
}

async function warmK3sImages(
	container: StartedK3sContainer,
	progress: K3sSetupProgress,
): Promise<void> {
	for (const [index, image] of WARMUP_IMAGES.entries()) {
		const imageNumber = index + 1;
		progress.imageStart(imageNumber, WARMUP_IMAGES.length, image);
		const pulled = await pullImageWithCtrProgress(
			image,
			imageNumber,
			WARMUP_IMAGES.length,
			progress,
		);
		if (!pulled) {
			progress.imageFallback(imageNumber, WARMUP_IMAGES.length, image);
		}
		const result = await container.exec(["crictl", "pull", image]);
		if (result.exitCode !== 0) {
			throw new Error(result.stderr || result.output || `Failed to pull ${image}`);
		}
		progress.imageDone(imageNumber, WARMUP_IMAGES.length, image);
	}
}

async function pullImageWithCtrProgress(
	image: string,
	index: number,
	total: number,
	progress: K3sSetupProgress,
): Promise<boolean> {
	const imageRef = canonicalCtrImageRef(image);
	const expectedBytes = await inspectImageSize(imageRef);
	if (expectedBytes) {
		progress.imageProgress(index, total, image, {
			downloadedBytes: 0,
			totalBytes: expectedBytes,
			message: "resolving",
		});
	}
	const child = spawn(
		"docker",
		[
			"exec",
			K3S_CONTAINER_NAME,
			"ctr",
			"-n",
			"k8s.io",
			"images",
			"pull",
			"--platform",
			containerPlatform(),
			imageRef,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);

	let output = "";
	let lastProgressAt = 0;
	let pendingFrame = "";
	const rawLog = new PullRawLog(image);
	const onData = (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		output += text;
		void rawLog.append(text);
		const frames = ctrProgressFrames(pendingFrame + text);
		pendingFrame = frames.pending;
		for (const frame of frames.complete) {
			const status = ctrProgressStatus(frame);
			if (!status) {
				continue;
			}
			const now = Date.now();
			if (now - lastProgressAt > 250) {
				progress.imageProgress(index, total, image, {
					...status,
					totalBytes: status.totalBytes ?? expectedBytes,
				});
				lastProgressAt = now;
			}
		}
	};

	child.stdout.on("data", onData);
	child.stderr.on("data", onData);

	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	const finalStatus = ctrProgressStatus(pendingFrame);
	if (finalStatus) {
		progress.imageProgress(index, total, image, {
			...finalStatus,
			totalBytes: finalStatus.totalBytes ?? expectedBytes,
		});
	}
	await rawLog.flush();
	if (exitCode === 0) {
		return true;
	}
	progress.imageProgress(index, total, image, {
		message: lastOutputLine(output) || "ctr pull unavailable",
	});
	return false;
}

class PullRawLog {
	private readonly writes: Promise<void>[] = [];
	private readonly path: string;

	constructor(image: string) {
		const fileName = `${process.pid}-${Date.now()}-${image.replace(/[^a-zA-Z0-9_.-]+/g, "_")}.log`;
		this.path = join(K3S_PULL_LOG_DIR, fileName);
		this.writes.push(
			mkdir(K3S_PULL_LOG_DIR, { recursive: true }).then(() =>
				appendFile(this.path, `# ctr pull raw output for ${image}\n`),
			),
		);
	}

	append(text: string): Promise<void> {
		const write = this.writes.at(-1)?.then(() => appendFile(this.path, text)) ?? Promise.resolve();
		this.writes.push(write);
		return write;
	}

	async flush(): Promise<void> {
		await Promise.allSettled(this.writes);
	}
}

async function inspectImageSize(imageRef: string): Promise<number | undefined> {
	const output = await spawnForOutput(
		"docker",
		["manifest", "inspect", "--verbose", imageRef],
		MANIFEST_INSPECT_TIMEOUT_MS,
	).catch(() => undefined);
	if (!output) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return undefined;
	}
	return imageSizeForPlatform(parsed);
}

async function isK3sContainerRunning(): Promise<boolean> {
	const output = await spawnForOutput(
		"docker",
		["inspect", "--format", "{{.State.Running}}", K3S_CONTAINER_NAME],
		2_000,
	).catch(() => undefined);
	return output?.trim() === "true";
}

async function spawnForOutput(command: string, args: string[], timeoutMs: number): Promise<string> {
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	const timeout = globalThis.setTimeout(() => {
		child.kill("SIGTERM");
		globalThis
			.setTimeout(() => {
				if (!child.killed) {
					child.kill("SIGKILL");
				}
			}, 1_000)
			.unref();
	}, timeoutMs);
	timeout.unref();

	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});

	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	globalThis.clearTimeout(timeout);
	if (exitCode !== 0) {
		throw new Error(stderr || `${command} ${args.join(" ")} failed`);
	}
	return stdout;
}

function imageSizeForPlatform(manifest: unknown): number | undefined {
	const entries = Array.isArray(manifest) ? manifest : [manifest];
	const exactSize = entries
		.map((entry) => imageSizeForManifestEntry(entry, "exact-platform"))
		.find((size) => size !== undefined);
	if (exactSize !== undefined) {
		return exactSize;
	}
	const fallbackEntries = entries.filter(isUsableLinuxManifestEntry);
	if (fallbackEntries.length === 1) {
		return imageSizeForManifestEntry(fallbackEntries[0], "any-platform");
	}
	if (entries.length === 1) {
		return imageSizeForManifestEntry(entries[0], "any-platform");
	}
	return undefined;
}

function imageSizeForManifestEntry(
	entry: unknown,
	platformMode: "any-platform" | "exact-platform",
): number | undefined {
	if (
		!isRecord(entry) ||
		(platformMode === "exact-platform" && !matchesCurrentPlatform(entry.Descriptor))
	) {
		return undefined;
	}
	const manifest = firstRecord(entry.SchemaV2Manifest, entry.OCIManifest, entry.Raw);
	if (!manifest) {
		return undefined;
	}
	const configSize = sizeField(manifest.config);
	const layerSizes = Array.isArray(manifest.layers)
		? manifest.layers.map(sizeField).filter((size) => size !== undefined)
		: [];
	if (configSize === undefined && layerSizes.length === 0) {
		return undefined;
	}
	return (configSize ?? 0) + layerSizes.reduce((sum, size) => sum + size, 0);
}

function isUsableLinuxManifestEntry(entry: unknown): boolean {
	if (!isRecord(entry)) {
		return false;
	}
	const descriptor = entry.Descriptor;
	if (!isRecord(descriptor)) {
		return true;
	}
	const platform = descriptor.platform;
	if (!isRecord(platform)) {
		return true;
	}
	return platform.os === "linux" && platform.architecture !== "unknown";
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
	for (const value of values) {
		if (isRecord(value)) {
			return value;
		}
		if (typeof value === "string") {
			const decoded = decodeRawManifest(value);
			if (decoded) {
				return decoded;
			}
		}
	}
	return undefined;
}

function decodeRawManifest(value: string): Record<string, unknown> | undefined {
	try {
		const decoded = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
		return isRecord(decoded) ? decoded : undefined;
	} catch {
		return undefined;
	}
}

function matchesCurrentPlatform(descriptor: unknown): boolean {
	if (!isRecord(descriptor)) {
		return true;
	}
	const platform = descriptor.platform;
	if (!isRecord(platform)) {
		return true;
	}
	return platform.os === "linux" && platform.architecture === containerArchitecture();
}

function sizeField(value: unknown): number | undefined {
	if (!isRecord(value) || typeof value.size !== "number" || !Number.isFinite(value.size)) {
		return undefined;
	}
	return value.size;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function canonicalCtrImageRef(image: string): string {
	const firstPathSegment = image.split("/")[0] ?? "";
	if (image.includes("/") && (firstPathSegment.includes(".") || firstPathSegment.includes(":"))) {
		return image;
	}
	if (!image.includes("/")) {
		return `docker.io/library/${image}`;
	}
	return `docker.io/${image}`;
}

function containerPlatform(): string {
	return `linux/${containerArchitecture()}`;
}

function containerArchitecture(): string {
	if (process.arch === "arm64") {
		return "arm64";
	}
	if (process.arch === "x64") {
		return "amd64";
	}
	return process.arch;
}

export function ctrProgressStatus(line: string): ImagePullStatus | undefined {
	const clean = stripAnsi(line).replace(/\s+/g, " ").trim();
	if (!clean) {
		return undefined;
	}
	const transfer = clean.match(
		/\belapsed:\s*.*?\btotal:\s*([0-9.]+)\s*([KMGT]?i?B?)?\s*\(([^)]*)\)/,
	);
	if (transfer) {
		const totalUnit = transfer[2] || inferByteUnitFromRate(transfer[3]);
		return {
			downloadedBytes: parseByteCount(transfer[1], totalUnit),
			rateBytesPerSecond: parseRate(transfer[3]),
		};
	}
	if (clean.includes("unpacking") || clean.includes("saved")) {
		return { message: clean };
	}
	return undefined;
}

function ctrProgressFrames(text: string): { complete: string[]; pending: string } {
	const parts = text.split(/\r|\n/);
	return {
		complete: parts.slice(0, -1),
		pending: parts.at(-1) ?? "",
	};
}

function inferByteUnitFromRate(value: string | undefined): string {
	return value?.match(/[0-9.]+\s*([KMGT]?i?)B\/s/)?.[1] ?? "";
}

function parseRate(value: string | undefined): number | undefined {
	if (!value || value === "0.0 B/s") {
		return undefined;
	}
	const rate = value.match(/([0-9.]+)\s*([KMGT]?i?)?B\/s/);
	if (!rate) {
		return undefined;
	}
	return parseByteCount(rate[1], rate[2] ?? "");
}

function parseByteCount(value: string | undefined, unit: string): number | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		return undefined;
	}
	return parsed * byteUnitMultiplier(unit);
}

function byteUnitMultiplier(unit: string): number {
	switch (normalizeByteUnit(unit)) {
		case "K":
			return 1_000;
		case "M":
			return 1_000_000;
		case "G":
			return 1_000_000_000;
		case "T":
			return 1_000_000_000_000;
		case "Ki":
			return 1024;
		case "Mi":
			return 1024 ** 2;
		case "Gi":
			return 1024 ** 3;
		case "Ti":
			return 1024 ** 4;
		default:
			return 1;
	}
}

function normalizeByteUnit(unit: string): string {
	if (unit.endsWith("B")) {
		return unit.slice(0, -1);
	}
	return unit;
}

function lastOutputLine(output: string): string | undefined {
	return stripAnsi(output)
		.split(/\r|\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
}

function stripAnsi(value: string): string {
	return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}
