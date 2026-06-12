import { afterAll, afterEach, beforeAll } from "vitest";
import * as realK8s from "@kubernetes/client-node";

import { node } from "../describe";
import type { SuiteOptions } from "../describe";
import { createKubernetesRuntimeContext } from "./kubernetes-context";
import type { KubernetesSuiteFactory, NodePortRequest, NodePortResponse } from "./kubernetes";
import {
	getK3sContainer,
	K3S_SETUP_TIMEOUT_MS,
	setupK3sInfrastructure,
} from "./kubernetes-k3s-setup";
import type { K8s, KubeConfig } from "../../client/types";
import type { ClusterApplyResource, ClusterApplyResult } from "../../cluster/apply";

let setupPromise: Promise<void> | undefined;

const k8s: K8s = realK8s;
const realKubeConfig = new realK8s.KubeConfig();
const kubeConfig: KubeConfig = realKubeConfig;

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
			apply,
		});

		beforeAll(async () => {
			await setupK3s();
			await context.initialize();
		}, K3S_SETUP_TIMEOUT_MS);
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
		const container = await setupK3sInfrastructure();
		realKubeConfig.loadFromString(container.getKubeConfig());
	})();
	await setupPromise;
}

async function fetchNodePort(
	nodePort: number,
	request?: NodePortRequest,
): Promise<NodePortResponse> {
	const container = await getK3sContainer();
	const path = request?.path ?? "/";
	const target = `http://127.0.0.1:${nodePort}${path}`;
	const result = await container.exec(["sh", "-c", nodePortFetchScript(target, request)]);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr || result.output || `NodePort request failed: ${target}`);
	}
	const parsed = parseNodePortFetchOutput(result.stdout);
	return {
		status: parsed.status,
		body: parsed.body,
	};
}

function nodePortFetchScript(target: string, request: NodePortRequest | undefined): string {
	const curlArgs = [
		"-sS",
		"-o",
		'"$body_file"',
		"-w",
		"%{http_code}",
		...curlRequestArgs(request),
		shellQuote(target),
	];
	return [
		"body_file=$(mktemp)",
		"headers_file=$(mktemp)",
		'trap \'rm -f "$body_file" "$headers_file"\' EXIT',
		"if command -v curl >/dev/null 2>&1; then",
		`  status=$(curl ${curlArgs.join(" ")})`,
		"  code=$?",
		"else",
		unsupportedWgetRequest(request)
			? "  echo 'curl is required for this NodePort request' >&2; exit 1"
			: `  wget -q -O "$body_file" -S ${shellQuote(target)} 2>"$headers_file"
  code=$?
  status=$(awk '/^  HTTP\\//{code=$2} END{print code}' "$headers_file")`,
		"fi",
		'if [ -z "$status" ] || [ "$status" = "000" ]; then',
		"  exit $code",
		"fi",
		'printf "__WEBERNETES_NODEPORT_STATUS__%s\\n" "$status"',
		'printf "__WEBERNETES_NODEPORT_BODY__"',
		'base64 < "$body_file" | tr -d "\\n"',
		'printf "\\n"',
	].join("\n");
}

function curlRequestArgs(request: NodePortRequest | undefined): string[] {
	const args: string[] = [];
	if (request?.method) {
		args.push("-X", shellQuote(request.method));
	}
	for (const [name, value] of Object.entries(request?.headers ?? {})) {
		args.push("-H", shellQuote(`${name}: ${value}`));
	}
	if (request?.body !== undefined) {
		args.push("--data-binary", shellQuote(request.body));
	}
	return args;
}

function unsupportedWgetRequest(request: NodePortRequest | undefined): boolean {
	return Boolean(
		request?.method || request?.body !== undefined || Object.keys(request?.headers ?? {}).length,
	);
}

function parseNodePortFetchOutput(output: string): NodePortResponse {
	const status = output.match(/^__WEBERNETES_NODEPORT_STATUS__(\d+)$/m)?.[1];
	const body = output.match(/^__WEBERNETES_NODEPORT_BODY__(.*)$/m)?.[1];
	if (!status || body === undefined) {
		throw new Error("NodePort request did not return a parseable response");
	}
	return {
		status: Number(status),
		body: Buffer.from(body, "base64").toString("utf8"),
	};
}

async function apply<const T extends readonly ClusterApplyResource[]>(
	resources: T,
): Promise<ClusterApplyResult<T>> {
	const container = await getK3sContainer();
	const input = Buffer.from(
		JSON.stringify({
			apiVersion: "v1",
			kind: "List",
			items: resources,
		}),
		"utf8",
	).toString("base64");
	const result = await container.exec([
		"sh",
		"-c",
		`printf %s ${shellQuote(input)} | base64 -d | kubectl apply -f - -o json`,
	]);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr || result.output || "kubectl apply failed");
	}
	return parseApplyOutput<T>(result.stdout);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function parseApplyOutput<const T extends readonly ClusterApplyResource[]>(
	output: string,
): ClusterApplyResult<T> {
	type Resource = T[number];
	const parsed = JSON.parse(output) as Resource & { items?: Resource[] };
	if (Array.isArray(parsed.items)) {
		return parsed.items as ClusterApplyResult<T>;
	}
	return [parsed] as ClusterApplyResult<T>;
}
