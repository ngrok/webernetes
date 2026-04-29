import { browser } from "../describe";
import type { SuiteOptions } from "../describe";
import { Clock } from "../../clock";
import { Etcd } from "../../cluster/etcd";
import type { EtcdSuiteFactory, EtcdTestContext } from "./etcd";

const context: EtcdTestContext = {
	target: "fake",
	name: "fake etcd",
	async createEtcd() {
		return new Etcd(new Clock());
	},
};

export function defineSuite(name: string, factory: EtcdSuiteFactory): void;
export function defineSuite(name: string, options: SuiteOptions, factory: EtcdSuiteFactory): void;
export function defineSuite(
	name: string,
	maybeOptions: SuiteOptions | EtcdSuiteFactory,
	maybeFactory?: EtcdSuiteFactory,
): void {
	const factory = typeof maybeOptions === "function" ? maybeOptions : maybeFactory;
	if (!factory) {
		throw new Error(`Missing fake etcd suite callback for ${name}`);
	}

	const suite = () => {
		factory(context);
	};

	if (typeof maybeOptions === "function") {
		browser.describe(name, suite);
		return;
	}
	browser.describe(name, maybeOptions, suite);
}
