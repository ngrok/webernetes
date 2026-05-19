import { describe, expect, it } from "vitest";
import * as fnv from "./fnv";
import * as hashutil from "./hashutil";

describe("fnv", () => {
	it("computes FNV-1a 32-bit hashes", () => {
		/*
		package main

		import (
			"fmt"
			"hash/fnv"
		)

		func main() {
			hash := fnv.New32a()
			hash.Write([]byte("hello"))
			fmt.Printf("0x%08x\n", hash.Sum32())
			// 0x4f9f2cab
		}
		*/
		const hash = fnv.new32a();
		hash.write("hello");
		expect(hash.sum32()).toBe(0x4f9f2cab);
	});
});

describe("hashutil", () => {
	it("deep-hashes JSON bytes using Kubernetes dump formatting", () => {
		/*
		package main

		import (
			"encoding/json"
			"fmt"
			"hash/fnv"

			hashutil "k8s.io/kubernetes/pkg/util/hash"
		)

		func main() {
			containerJSON, _ := json.Marshal(map[string]string{
				"name":  "test_container",
				"image": "foo/image:v1",
			})
			hash := fnv.New32a()
			hashutil.DeepHashObject(hash, containerJSON)
			fmt.Printf("%s\n0x%08x\n", containerJSON, hash.Sum32())
			// {"image":"foo/image:v1","name":"test_container"}
			// 0x8e45cbd0
		}
		*/
		const hash = fnv.new32a();
		hashutil.DeepHashObject(
			hash,
			hashutil.jsonMarshal({
				name: "test_container",
				image: "foo/image:v1",
			}),
		);

		expect(hash.sum32()).toBe(0x8e45cbd0);
	});

	it("marshals object fields in a stable lexical order", () => {
		/*
		package main

		import (
			"encoding/json"
			"fmt"
		)

		func main() {
			containerJSON, _ := json.Marshal(map[string]string{
				"name":  "test_container",
				"image": "foo/image:v1",
			})
			fmt.Printf("%s\n", containerJSON)
			// {"image":"foo/image:v1","name":"test_container"}
		}
		*/
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
