import { afterAll, beforeAll } from "vitest";
import { Etcd3 } from "etcd3";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

import { node } from "../describe";
import type { SuiteOptions } from "../describe";
import type { EtcdSuiteFactory, EtcdTestContext } from "./etcd";

let containerPromise: Promise<StartedTestContainer> | undefined;

const context: EtcdTestContext = {
	target: "real",
	name: "real etcd",
	createEtcd: createRealEtcd,
};

afterAll(async () => {
	const container = await containerPromise;
	await container?.stop();
});

export function defineSuite(name: string, factory: EtcdSuiteFactory): void;
export function defineSuite(name: string, options: SuiteOptions, factory: EtcdSuiteFactory): void;
export function defineSuite(
	name: string,
	maybeOptions: SuiteOptions | EtcdSuiteFactory,
	maybeFactory?: EtcdSuiteFactory,
): void {
	const factory = typeof maybeOptions === "function" ? maybeOptions : maybeFactory;
	if (!factory) {
		throw new Error(`Missing real etcd suite callback for ${name}`);
	}

	const suite = () => {
		beforeAll(async () => {
			await getEtcdContainer();
		});
		factory(context);
	};

	if (typeof maybeOptions === "function") {
		node.describe(name, suite);
		return;
	}
	node.describe(name, maybeOptions, suite);
}

async function getEtcdContainer(): Promise<StartedTestContainer> {
	containerPromise ??= new GenericContainer("registry.k8s.io/etcd:3.6.4-0")
		.withCommand([
			"etcd",
			"--listen-client-urls=http://0.0.0.0:2379",
			"--advertise-client-urls=http://0.0.0.0:2379",
			"--listen-peer-urls=http://0.0.0.0:2380",
			"--initial-advertise-peer-urls=http://0.0.0.0:2380",
			"--initial-cluster=default=http://0.0.0.0:2380",
		])
		.withExposedPorts(2379)
		.withWaitStrategy(Wait.forLogMessage("ready to serve client requests"))
		.start();

	return await containerPromise;
}

async function createRealEtcd(): Promise<Etcd3> {
	const container = await getEtcdContainer();
	return new Etcd3({
		hosts: [`${container.getHost()}:${container.getMappedPort(2379)}`],
	});
}
