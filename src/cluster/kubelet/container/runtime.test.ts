import { expect, it } from "vitest";
import { browser } from "../../../test/describe";
import {
	networkReady,
	RuntimeCondition,
	RuntimeFeatures,
	RuntimeHandler,
	RuntimeStatus,
	runtimeReady,
} from "./runtime";

browser.describe("RuntimeStatus", () => {
	it("finds runtime conditions by type", () => {
		const status = new RuntimeStatus({
			conditions: [
				new RuntimeCondition({
					type: runtimeReady,
					status: true,
					reason: "ready",
					message: "runtime is ready",
				}),
				new RuntimeCondition({
					type: networkReady,
					status: false,
					reason: "not ready",
					message: "network is not ready",
				}),
			],
		});

		expect(status.getRuntimeCondition(runtimeReady)).toBe(status.conditions[0]);
		expect(status.getRuntimeCondition(networkReady)).toBe(status.conditions[1]);
		expect(status.getRuntimeCondition("NonExistent")).toBeUndefined();
	});

	it("formats runtime status", () => {
		const status = new RuntimeStatus({
			conditions: [
				new RuntimeCondition({
					type: runtimeReady,
					status: true,
					reason: "ready",
					message: "runtime is ready",
				}),
				new RuntimeCondition({
					type: networkReady,
					status: false,
					reason: "not ready",
					message: "network is not ready",
				}),
			],
			handlers: [
				new RuntimeHandler({
					name: "handler1",
					supportsRecursiveReadOnlyMounts: true,
					supportsUserNamespaces: false,
				}),
				new RuntimeHandler({
					name: "handler2",
					supportsRecursiveReadOnlyMounts: false,
					supportsUserNamespaces: true,
				}),
			],
			features: new RuntimeFeatures({
				supplementalGroupsPolicy: true,
				userNamespacesHostNetwork: true,
			}),
		});

		expect(status.toString()).toBe(
			"Runtime Conditions: RuntimeReady=true reason:ready message:runtime is ready, NetworkReady=false reason:not ready message:network is not ready; Handlers: Name=handler1 SupportsRecursiveReadOnlyMounts: true SupportsUserNamespaces: false, Name=handler2 SupportsRecursiveReadOnlyMounts: false SupportsUserNamespaces: true, Features: SupplementalGroupsPolicy: true UserNamespacesHostNetwork: true",
		);
	});
});
