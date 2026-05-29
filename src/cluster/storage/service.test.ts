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
		const contended = new Map<number, V1Service>();
		const store = new ContendedServiceStore(etcd, {
			waitAtCreate: createBarrier(2),
			onCreateReady: (service) => contended.set(service.spec?.ports?.[0]?.port ?? 0, service),
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

		const winnerPort = fulfilled[0]?.value.spec?.ports?.[0]?.port;
		const loser = winnerPort === 80 ? contended.get(81) : contended.get(80);
		if (!loser) {
			throw new Error("Expected losing Service to be captured");
		}
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
		const contended = new Map<number, V1Service>();
		const store = new ContendedServiceStore(etcd, {
			waitAtUpdate: createBarrier(2),
			onUpdateReady: (service) => contended.set(service.spec?.ports?.[0]?.port ?? 0, service),
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

		const winnerPort = fulfilled[0]?.value.spec?.ports?.[0]?.port;
		const loser = winnerPort === 80 ? contended.get(81) : contended.get(80);
		if (!loser) {
			throw new Error("Expected losing Service to be captured");
		}
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
	onCreateReady?: (service: V1Service) => void;
	onUpdateReady?: (service: V1Service) => void;
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
		this.contendedOptions.onCreateReady?.(structuredClone(service));
		await this.contendedOptions.waitAtCreate?.();
	}

	protected override async validateUpdate(service: V1Service, existing: V1Service): Promise<void> {
		await super.validateUpdate(service, existing);
		this.contendedOptions.onUpdateReady?.(structuredClone(service));
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
