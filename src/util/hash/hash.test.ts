import { expect, it } from "vitest";

import * as fnv from "../../fnv";
import { browser } from "../../test/describe";
import * as hashutil from "./hash";

browser.describe("hashutil", () => {
	// Models kubernetes/pkg/util/hash/hash_test.go TestDeepHashObject.
	it("deep-hashes JSON bytes using Kubernetes dump formatting", () => {
		const hash = fnv.new32a();
		hashutil.deepHashObject(
			hash,
			hashutil.jsonMarshal({
				name: "test_container",
				image: "foo/image:v1",
			}),
		);

		expect(hash.sum32()).toBe(0x8e45cbd0);
	});

	// Models kubernetes/pkg/util/hash/hash_test.go TestDeepHashObject.
	it("resets the hasher and produces deterministic hashes", () => {
		const hash = fnv.new32a();
		const object = hashutil.jsonMarshal({ eight: 8, six: 6, seven: 7 });
		hashutil.deepHashObject(hash, object);
		const first = hash.sum32();
		hash.write("extra");
		hashutil.deepHashObject(hash, object);
		expect(hash.sum32()).toBe(first);
	});

	it("marshals object fields in a stable lexical order", () => {
		expect(
			new TextDecoder().decode(
				hashutil.jsonMarshal({
					name: "test_container",
					image: "foo/image:v1",
				}),
			),
		).toBe('{"image":"foo/image:v1","name":"test_container"}');
	});
});
