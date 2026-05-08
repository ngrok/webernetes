import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterAll, afterEach, beforeAll } from "vitest";
import { K3sContainer, type StartedK3sContainer } from "@testcontainers/k3s";
import * as realK8s from "@kubernetes/client-node";

import { node } from "../describe";
import type { SuiteOptions } from "../describe";
import { createKubernetesRuntimeContext } from "./kubernetes-context";
import type { KubernetesSuiteFactory, NodePortRequest, NodePortResponse } from "./kubernetes";
import type { K8s, KubeConfig } from "../../client/types";

let containerPromise: Promise<StartedK3sContainer> | undefined;
let setupPromise: Promise<void> | undefined;

const K3S_CONTAINER_NAME = "k8s-web-simulator-k3s";
const K3S_START_LOCK_DIR = join(tmpdir(), `${K3S_CONTAINER_NAME}.lock`);
const K3S_START_LOCK_STALE_MS = 5 * 60 * 1000;
const K3S_START_LOCK_WAIT_MS = 250;

const WARMUP_IMAGES = [
	"registry.k8s.io/pause:3.10",
	"registry.k8s.io/e2e-test-images/agnhost:2.40",
	"busybox:1.36",
	"hashicorp/http-echo:1.0",
	"crccheck/hello-world:latest",
];

const k8s = realK8s as unknown as K8s;
const realKubeConfig = new realK8s.KubeConfig();
const kubeConfig = realKubeConfig as unknown as KubeConfig;

export function defineSuite(name: string, factory: KubernetesSuiteFactory): void;
export function defineSuite(
	name: string,
	options: SuiteOptions,
	factory: KubernetesSuiteFactory,
): void;
export function defineSuite(
	name: string,
	maybeOptions: SuiteOptions | KubernetesSuiteFactory,
	maybeFactory?: KubernetesSuiteFactory,
): void {
	const factory = typeof maybeOptions === "function" ? maybeOptions : maybeFactory;
	if (!factory) {
		throw new Error(`Missing k3s suite callback for ${name}`);
	}

	const suite = () => {
		const context = createKubernetesRuntimeContext({
			k8s,
			kubeConfig,
			target: "k3s",
			fetchNodePort,
		});

		beforeAll(async () => {
			await setupK3s();
			await context.initialize();
		});
		afterAll(async () => {
			await context.dispose();
		});
		afterEach(async () => {
			await context.disposeTest();
		});
		factory(context);
	};

	if (typeof maybeOptions === "function") {
		node.describe(name, suite);
		return;
	}
	node.describe(name, maybeOptions, suite);
}

async function setupK3s(): Promise<void> {
	setupPromise ??= (async () => {
		const container = await getK3sContainer();
		realKubeConfig.loadFromString(container.getKubeConfig());
		await waitForK3sNodeReady(container);
		await warmK3sImages(container);
	})();
	await setupPromise;
}

async function getK3sContainer(): Promise<StartedK3sContainer> {
	containerPromise ??= withK3sStartupLock(() =>
		new K3sContainer("rancher/k3s:v1.35.4-rc3-k3s1")
			.withName(K3S_CONTAINER_NAME)
			.withCommand(["server", "--disable=traefik", "--disable=metrics-server"])
			.withReuse()
			.start(),
	);
	return await containerPromise;
}

async function withK3sStartupLock<T>(callback: () => Promise<T>): Promise<T> {
	while (!(await tryAcquireK3sStartupLock())) {
		await setTimeout(K3S_START_LOCK_WAIT_MS);
	}

	try {
		return await callback();
	} finally {
		await rm(K3S_START_LOCK_DIR, { force: true, recursive: true });
	}
}

async function tryAcquireK3sStartupLock(): Promise<boolean> {
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
		return await tryAcquireK3sStartupLock();
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

async function fetchNodePort(
	nodePort: number,
	request?: NodePortRequest,
): Promise<NodePortResponse> {
	const container = await getK3sContainer();
	const path = request?.path ?? "/";
	const target = `http://127.0.0.1:${nodePort}${path}`;
	const result = await container.exec([
		"sh",
		"-c",
		`if command -v wget >/dev/null 2>&1; then wget -q -O - ${shellQuote(
			target,
		)}; else curl -fsSL ${shellQuote(target)}; fi`,
	]);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr || result.output || `NodePort request failed: ${target}`);
	}
	return {
		status: 200,
		body: result.stdout,
	};
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

async function warmK3sImages(container: StartedK3sContainer): Promise<void> {
	for (const image of WARMUP_IMAGES) {
		const result = await container.exec(["crictl", "pull", image]);
		if (result.exitCode !== 0) {
			throw new Error(result.stderr || result.output || `Failed to pull ${image}`);
		}
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}
