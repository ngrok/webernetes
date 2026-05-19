import { afterEach, beforeEach, expect, it } from "vitest";

import type { V1Service } from "../../client";
import { fakeEtcd } from "../../test/harnesses/etcd";
import type { Etcd } from "../etcd";
import { createBarrier } from "./helpers";
import { NamespaceStore } from "./namespace";
import { ServiceStore } from "./service";

fakeEtcd.describe("ServiceStore allocation transactions", ({ createEtcd }) => {
	let etcd: Etcd;

	beforeEach(async () => {
		etcd = (await createEtcd()) as Etcd;
		await etcd.delete().all().exec();
		await ServiceStore.initialize(etcd, { nodePortRange: { from: 30000, to: 30010 } });
		await new NamespaceStore(etcd).create({ metadata: { name: "default" } });
	});

	afterEach(() => {
		etcd.close();
	});

	it("reverts allocations from a losing concurrent create", async () => {
		const store = new ContendedServiceStore(etcd, {
			waitAtCreate: createBarrier(2),
		});
		const first: V1Service = nodePortService("contended-create", 80);
		const second: V1Service = nodePortService("contended-create", 81);

		const results = await Promise.allSettled([store.create(first), store.create(second)]);
		const fulfilled = results.filter(
			(result): result is PromiseFulfilledResult<V1Service> => result.status === "fulfilled",
		);
		const rejected = results.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);

		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);

		const winner = fulfilled[0]?.value;
		const loser = winner === first ? second : first;
		const loserClusterIP = requiredClusterIP(loser);
		const loserNodePort = requiredNodePort(loser);

		await store.delete("contended-create", "default");

		await expect(
			store.create({
				metadata: { name: "reuse-losing-create", namespace: "default" },
				spec: {
					type: "NodePort",
					clusterIP: loserClusterIP,
					ports: [{ port: 80, nodePort: loserNodePort }],
				},
			}),
		).resolves.toMatchObject({
			spec: {
				clusterIP: loserClusterIP,
				ports: [expect.objectContaining({ nodePort: loserNodePort })],
			},
		});
	});

	it("reverts allocations from a losing concurrent update", async () => {
		const store = new ContendedServiceStore(etcd, {
			waitAtUpdate: createBarrier(2),
		});
		const created = await store.create({
			metadata: { name: "contended-update", namespace: "default" },
			spec: { type: "ClusterIP", ports: [{ port: 80 }] },
		});
		const first: V1Service = nodePortService("contended-update", 80, created);
		const second: V1Service = nodePortService("contended-update", 81, created);

		const results = await Promise.allSettled([
			store.update("contended-update", first),
			store.update("contended-update", second),
		]);
		const fulfilled = results.filter(
			(result): result is PromiseFulfilledResult<V1Service> => result.status === "fulfilled",
		);
		const rejected = results.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);

		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);

		const winner = fulfilled[0]?.value;
		const loser = winner === first ? second : first;
		const loserNodePort = requiredNodePort(loser);

		await store.delete("contended-update", "default");

		await expect(
			store.create({
				metadata: { name: "reuse-losing-update", namespace: "default" },
				spec: {
					type: "NodePort",
					ports: [{ port: 80, nodePort: loserNodePort }],
				},
			}),
		).resolves.toMatchObject({
			spec: {
				ports: [expect.objectContaining({ nodePort: loserNodePort })],
			},
		});
	});
});

interface ContendedServiceOptions {
	waitAtCreate?: () => Promise<void>;
	waitAtUpdate?: () => Promise<void>;
}

class ContendedServiceStore extends ServiceStore {
	constructor(
		etcd: Etcd,
		private readonly contendedOptions: ContendedServiceOptions,
	) {
		super(etcd, { nodePortRange: { from: 30000, to: 30010 } });
	}

	protected override async validateCreate(service: V1Service): Promise<void> {
		await super.validateCreate(service);
		await this.contendedOptions.waitAtCreate?.();
	}

	protected override async validateUpdate(service: V1Service, existing: V1Service): Promise<void> {
		await super.validateUpdate(service, existing);
		await this.contendedOptions.waitAtUpdate?.();
	}
}

function nodePortService(name: string, port: number, existing?: V1Service): V1Service {
	return {
		metadata: {
			name,
			namespace: "default",
			resourceVersion: existing?.metadata?.resourceVersion,
		},
		spec: {
			type: "NodePort",
			ports: [{ port }],
		},
	};
}

function requiredClusterIP(service: V1Service): string {
	const clusterIP = service.spec?.clusterIP;
	if (!clusterIP) {
		throw new Error("Expected Service to have a clusterIP");
	}
	return clusterIP;
}

function requiredNodePort(service: V1Service): number {
	const nodePort = service.spec?.ports?.[0]?.nodePort;
	if (nodePort === undefined) {
		throw new Error("Expected Service to have a nodePort");
	}
	return nodePort;
}
