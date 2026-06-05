import { expect, it } from "vitest";

import type { KubernetesObject } from "../../../client/types";
import { browser } from "../../../test/describe";
import { ExplicitKey } from "./store";
import { newUndeltaStore } from "./undelta_store";

interface TestUndeltaObject extends KubernetesObject {
	name: string;
	val: string | number;
	nested?: {
		val: string;
	};
}

browser.describe("UndeltaStore", () => {
	// Models staging/src/k8s.io/client-go/tools/cache/undelta_store_test.go TestUpdateCallsPush.
	it("calls push on update", async () => {
		const mkObj = (name: string, val: string | number): TestUndeltaObject => ({ name, val });
		let got: TestUndeltaObject[] = [];
		let callcount = 0;
		const push = (m: TestUndeltaObject[]) => {
			callcount++;
			got = m;
		};
		const u = newUndeltaStore(push, testUndeltaKeyFunc);

		await u.add(mkObj("a", 2));
		await u.update(mkObj("a", 1));

		expect(callcount).toBe(2);
		expect(got).toEqual([mkObj("a", 1)]);
	});

	// Models staging/src/k8s.io/client-go/tools/cache/undelta_store_test.go TestDeleteCallsPush.
	it("calls push on delete", async () => {
		const mkObj = (name: string, val: string | number): TestUndeltaObject => ({ name, val });
		let got: TestUndeltaObject[] = [];
		let callcount = 0;
		const push = (m: TestUndeltaObject[]) => {
			callcount++;
			got = m;
		};
		const u = newUndeltaStore(push, testUndeltaKeyFunc);

		await u.add(mkObj("a", 2));
		await u.delete(mkObj("a", ""));

		expect(callcount).toBe(2);
		expect(got).toEqual([]);
	});

	// Models staging/src/k8s.io/client-go/tools/cache/undelta_store_test.go TestReadsDoNotCallPush.
	it("does not call push on reads", async () => {
		let callcount = 0;
		const push = () => {
			callcount++;
		};
		const u = newUndeltaStore(push, testUndeltaKeyFunc);

		u.list();
		await u.get({ name: "a", val: "" });

		expect(callcount).toBe(0);
	});

	// Models staging/src/k8s.io/client-go/tools/cache/undelta_store_test.go TestReplaceCallsPush.
	it("calls push on replace", async () => {
		const mkObj = (name: string, val: string | number): TestUndeltaObject => ({ name, val });
		let got: TestUndeltaObject[] = [];
		let callcount = 0;
		const push = (m: TestUndeltaObject[]) => {
			callcount++;
			got = m;
		};
		const u = newUndeltaStore(push, testUndeltaKeyFunc);

		const m = [mkObj("a", 1)];
		await u.replace(m, "0");

		expect(callcount).toBe(1);
		expect(got).toEqual([mkObj("a", 1)]);
	});

	it("does not expose stored object references through reads or pushes", async () => {
		let got: TestUndeltaObject[] = [];
		const push = (m: TestUndeltaObject[]) => {
			got = m;
		};
		const u = newUndeltaStore(push, testUndeltaKeyFunc);

		await u.add({ name: "a", val: 1, nested: { val: "stored" } });

		const [pushed] = got;
		if (!pushed?.nested) {
			throw new Error("expected pushed object with nested value");
		}
		pushed.val = "pushed mutation";
		pushed.nested.val = "pushed mutation";

		const [afterPush] = u.getByKey("a");
		expect(afterPush).toEqual({ name: "a", val: 1, nested: { val: "stored" } });

		const [listed] = u.list();
		if (!listed?.nested) {
			throw new Error("expected listed object with nested value");
		}
		listed.val = "listed mutation";
		listed.nested.val = "listed mutation";

		const [afterList] = u.getByKey("a");
		expect(afterList).toEqual({ name: "a", val: 1, nested: { val: "stored" } });
	});
});

// Models staging/src/k8s.io/client-go/tools/cache/undelta_store_test.go testUndeltaKeyFunc.
function testUndeltaKeyFunc(obj: TestUndeltaObject | ExplicitKey): [string, Error | undefined] {
	if (obj instanceof ExplicitKey) {
		return [obj.key, undefined];
	}
	return [obj.name, undefined];
}
