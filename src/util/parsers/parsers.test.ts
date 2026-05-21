import { describe, expect, it } from "vitest";
import { parse, parseImageName, parseNormalizedNamed } from "./parsers";

function tagOf(ref: unknown): string {
	if (ref !== undefined && ref !== null && typeof (ref as { tag?: unknown }).tag === "function") {
		return (ref as { tag(): string }).tag();
	}
	return "";
}

function digestOf(ref: unknown): string {
	if (
		ref !== undefined &&
		ref !== null &&
		typeof (ref as { digest?: unknown }).digest === "function"
	) {
		return (ref as { digest(): string }).digest();
	}
	return "";
}

function nameOf(ref: unknown): string {
	if (ref !== undefined && ref !== null && typeof (ref as { name?: unknown }).name === "function") {
		return (ref as { name(): string }).name();
	}
	return "";
}

function domainOf(ref: unknown): string {
	if (
		ref !== undefined &&
		ref !== null &&
		typeof (ref as { domain?: unknown }).domain === "function"
	) {
		return (ref as { domain(): string }).domain();
	}
	return "";
}

interface ParseSuccessCase {
	input: string;
	name: string;
	domain?: string;
	tag?: string;
	digest?: string;
}

describe("parseImageName", () => {
	it.each([
		["root", "docker.io/library/root", "latest", ""],
		["root:tag", "docker.io/library/root", "tag", ""],
		[
			"root@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			"docker.io/library/root",
			"",
			"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		],
		["user/repo", "docker.io/user/repo", "latest", ""],
		["user/repo:tag", "docker.io/user/repo", "tag", ""],
		[
			"user/repo@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			"docker.io/user/repo",
			"",
			"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		],
		["url:5000/repo", "url:5000/repo", "latest", ""],
		["url:5000/repo:tag", "url:5000/repo", "tag", ""],
		[
			"url:5000/repo@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			"url:5000/repo",
			"",
			"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		],
		[
			"url:5000/repo:latest@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			"url:5000/repo",
			"latest",
			"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		],
	])("parses %s", (input, expectedRepo, expectedTag, expectedDigest) => {
		const [repo, tag, digest, err] = parseImageName(input);

		expect(err).toBeUndefined();
		expect(repo).toBe(expectedRepo);
		expect(tag).toBe(expectedTag);
		expect(digest).toBe(expectedDigest);
	});

	it.each([
		[
			"ROOT",
			`couldn't parse image name "ROOT": invalid reference format: repository name (library/ROOT) must be lowercase`,
		],
		["http://root", `couldn't parse image name "http://root": invalid reference format`],
		[
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			`couldn't parse image name "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855": invalid repository name (e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855), cannot specify 64-byte hexadecimal strings`,
		],
	])("returns the parse error for %s", (input, expectedMessage) => {
		const [, , , err] = parseImageName(input);

		expect(err?.message).toBe(expectedMessage);
	});
});

describe("parse", () => {
	const parseSuccessCases: ParseSuccessCase[] = [
		{ input: "test_com", name: "test_com" },
		{ input: "test.com:tag", name: "test.com", tag: "tag" },
		{ input: "test.com:5000", name: "test.com", tag: "5000" },
		{ input: "test.com/repo:tag", name: "test.com/repo", domain: "test.com", tag: "tag" },
		{ input: "test:5000/repo", name: "test:5000/repo", domain: "test:5000" },
		{ input: "test:5000/repo:tag", name: "test:5000/repo", domain: "test:5000", tag: "tag" },
		{
			input:
				"test:5000/repo@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
			name: "test:5000/repo",
			domain: "test:5000",
			digest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		},
		{
			input:
				"test:5000/repo:tag@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
			name: "test:5000/repo",
			domain: "test:5000",
			tag: "tag",
			digest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		},
		{ input: "lowercase:Uppercase", name: "lowercase", tag: "Uppercase" },
		{
			input: `${"a/".repeat(127)}a:tag-puts-this-over-max`,
			name: `${"a/".repeat(127)}a`,
			domain: "a",
			tag: "tag-puts-this-over-max",
		},
		{
			input: "sub-dom1.foo.com/bar/baz/quux",
			name: "sub-dom1.foo.com/bar/baz/quux",
			domain: "sub-dom1.foo.com",
		},
		{
			input: "sub-dom1.foo.com/bar/baz/quux:some-long-tag",
			name: "sub-dom1.foo.com/bar/baz/quux",
			domain: "sub-dom1.foo.com",
			tag: "some-long-tag",
		},
		{
			input: "b.gcr.io/test.example.com/my-app:test.example.com",
			name: "b.gcr.io/test.example.com/my-app",
			domain: "b.gcr.io",
			tag: "test.example.com",
		},
		{
			input: "xn--n3h.com/myimage:xn--n3h.com",
			name: "xn--n3h.com/myimage",
			domain: "xn--n3h.com",
			tag: "xn--n3h.com",
		},
		{
			input: "xn--7o8h.com/myimage:xn--7o8h.com@sha512:" + "f".repeat(128),
			name: "xn--7o8h.com/myimage",
			domain: "xn--7o8h.com",
			tag: "xn--7o8h.com",
			digest: `sha512:${"f".repeat(128)}`,
		},
		{ input: "foo_bar.com:8080", name: "foo_bar.com", tag: "8080" },
		{ input: "foo/foo_bar.com:8080", name: "foo/foo_bar.com", domain: "foo", tag: "8080" },
		{ input: "192.168.1.1", name: "192.168.1.1" },
		{ input: "192.168.1.1:tag", name: "192.168.1.1", tag: "tag" },
		{ input: "192.168.1.1:5000", name: "192.168.1.1", tag: "5000" },
		{ input: "192.168.1.1/repo", name: "192.168.1.1/repo", domain: "192.168.1.1" },
		{
			input: "192.168.1.1:5000/repo",
			name: "192.168.1.1:5000/repo",
			domain: "192.168.1.1:5000",
		},
		{
			input: "192.168.1.1:5000/repo:5050",
			name: "192.168.1.1:5000/repo",
			domain: "192.168.1.1:5000",
			tag: "5050",
		},
		{ input: "[2001:db8::1]/repo", name: "[2001:db8::1]/repo", domain: "[2001:db8::1]" },
		{
			input: "[2001:db8:1:2:3:4:5:6]/repo:tag",
			name: "[2001:db8:1:2:3:4:5:6]/repo",
			domain: "[2001:db8:1:2:3:4:5:6]",
			tag: "tag",
		},
		{
			input: "[2001:db8::1]:5000/repo",
			name: "[2001:db8::1]:5000/repo",
			domain: "[2001:db8::1]:5000",
		},
		{
			input: "[2001:db8::1]:5000/repo:tag",
			name: "[2001:db8::1]:5000/repo",
			domain: "[2001:db8::1]:5000",
			tag: "tag",
		},
		{
			input:
				"[2001:db8::1]:5000/repo@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
			name: "[2001:db8::1]:5000/repo",
			domain: "[2001:db8::1]:5000",
			digest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		},
		{
			input: "[2001:db8::1]:5000/repo:tag@sha256:" + "f".repeat(64),
			name: "[2001:db8::1]:5000/repo",
			domain: "[2001:db8::1]:5000",
			tag: "tag",
			digest: `sha256:${"f".repeat(64)}`,
		},
		{
			input: "[2001:db8::]:5000/repo",
			name: "[2001:db8::]:5000/repo",
			domain: "[2001:db8::]:5000",
		},
		{ input: "[::1]:5000/repo", name: "[::1]:5000/repo", domain: "[::1]:5000" },
		{
			input: `example.com/${"a".repeat(255)}:tag`,
			name: `example.com/${"a".repeat(255)}`,
			domain: "example.com",
			tag: "tag",
		},
	];

	it.each(parseSuccessCases)(
		"parses $input",
		({ input, name, domain = "", tag = "", digest = "" }) => {
			const [ref, err] = parse(input);

			expect(err).toBeUndefined();
			expect(ref?.string()).toBe(input);
			expect(nameOf(ref)).toBe(name);
			expect(domainOf(ref)).toBe(domain);
			expect(tagOf(ref)).toBe(tag);
			expect(digestOf(ref)).toBe(digest);
		},
	);

	it.each([
		["", "repository name must have at least one component"],
		[":justtag", "invalid reference format"],
		[
			"@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
			"invalid reference format",
		],
		["repo@sha256:ffffffffffffffffffffffffffffffffff", "invalid checksum digest length"],
		[
			"validname@invaliddigest:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
			"unsupported digest algorithm",
		],
		["Uppercase:tag", "repository name must be lowercase"],
		["test:5000/Uppercase/lowercase:tag", "repository name must be lowercase"],
		[`domain/${"a".repeat(256)}:tag`, "repository name must not be more than 255 characters"],
		["aa/asdf$$^/aa", "invalid reference format"],
		["[2001:db8::1]", "invalid reference format"],
		["[2001:db8::1]:5000", "invalid reference format"],
		["[2001:db8::1]:tag", "invalid reference format"],
		["[fe80::1%eth0]:5000/repo", "invalid reference format"],
		["[fe80::1%@invalidzone]:5000/repo", "invalid reference format"],
	])("returns the parse error for %s", (input, expectedMessage) => {
		const [, err] = parse(input);

		expect(err?.message).toBe(expectedMessage);
	});
});

describe("parseNormalizedNamed", () => {
	it.each([
		["docker/docker", "docker.io/docker/docker"],
		["library/debian", "docker.io/library/debian"],
		["debian", "docker.io/library/debian"],
		["localhost/library/debian", "localhost/library/debian"],
		["localhost/debian", "localhost/debian"],
		["LOCALDOMAIN/library/debian", "LOCALDOMAIN/library/debian"],
		["LOCALDOMAIN/debian", "LOCALDOMAIN/debian"],
		["docker.io/docker/docker", "docker.io/docker/docker"],
		["docker.io/library/debian", "docker.io/library/debian"],
		["docker.io/debian", "docker.io/library/debian"],
		["index.docker.io/docker/docker", "docker.io/docker/docker"],
		["index.docker.io/library/debian", "docker.io/library/debian"],
		["index.docker.io/debian", "docker.io/library/debian"],
		["127.0.0.1:5000/docker/docker", "127.0.0.1:5000/docker/docker"],
		["127.0.0.1:5000/library/debian", "127.0.0.1:5000/library/debian"],
		["127.0.0.1:5000/debian", "127.0.0.1:5000/debian"],
		["192.168.0.1", "docker.io/library/192.168.0.1"],
		["192.168.0.1:80", "docker.io/library/192.168.0.1:80"],
		["192.168.0.1:8/debian", "192.168.0.1:8/debian"],
		["192.168.0.2:25000/debian", "192.168.0.2:25000/debian"],
		[
			"thisisthesongthatneverendsitgoesonandonandonthisisthesongthatnev",
			"docker.io/library/thisisthesongthatneverendsitgoesonandonandonthisisthesongthatnev",
		],
		["[fc00::1]:5000/docker", "[fc00::1]:5000/docker"],
		["[fc00::1]:5000/docker/docker", "[fc00::1]:5000/docker/docker"],
		["[fc00:1:2:3:4:5:6:7]:5000/library/debian", "[fc00:1:2:3:4:5:6:7]:5000/library/debian"],
		[
			"docker.io/1a3f5e7d9c1b3a5f7e9d1c3b5a7f9e1d3c5b7a9f1e3d5d7c9b1a3f5e7d9c1b3a",
			"docker.io/library/1a3f5e7d9c1b3a5f7e9d1c3b5a7f9e1d3c5b7a9f1e3d5d7c9b1a3f5e7d9c1b3a",
		],
		["Docker/docker", "Docker/docker"],
		["DOCKER/docker", "DOCKER/docker"],
		["docker-rules/docker", "docker.io/docker-rules/docker"],
		["docker---rules/docker", "docker.io/docker---rules/docker"],
		["doc/docker", "docker.io/doc/docker"],
		["d/docker", "docker.io/d/docker"],
		["jess/t", "docker.io/jess/t"],
		["dock__er/docker", "docker.io/dock__er/docker"],
	])("normalizes %s", (input, expectedString) => {
		const [named, err] = parseNormalizedNamed(input);

		expect(err).toBeUndefined();
		expect(named.string()).toBe(expectedString);
	});

	it.each([
		["https://github.com/docker/docker", "invalid reference format"],
		[
			"docker/Docker",
			"invalid reference format: repository name (docker/Docker) must be lowercase",
		],
		["-docker", "invalid reference format"],
		["-docker/docker", "invalid reference format"],
		["-docker.io/docker/docker", "invalid reference format"],
		["docker///docker", "invalid reference format"],
		[
			"docker.io/docker/Docker",
			"invalid reference format: repository name (docker/Docker) must be lowercase",
		],
		["docker.io/docker///docker", "invalid reference format"],
		["[fc00::1]", "invalid reference format"],
		["[fc00::1]:5000", "invalid reference format"],
		["fc00::1:5000/debian", "invalid reference format"],
		["[fe80::1%eth0]:5000/debian", "invalid reference format"],
		["[2001:db8:3:4::192.0.2.33]:5000/debian", "invalid reference format"],
		[
			"1a3f5e7d9c1b3a5f7e9d1c3b5a7f9e1d3c5b7a9f1e3d5d7c9b1a3f5e7d9c1b3a",
			"invalid repository name (1a3f5e7d9c1b3a5f7e9d1c3b5a7f9e1d3c5b7a9f1e3d5d7c9b1a3f5e7d9c1b3a), cannot specify 64-byte hexadecimal strings",
		],
		["docker-/docker", "invalid reference format"],
		["-docker-/docker", "invalid reference format"],
		["____/____", "invalid reference format"],
		["_docker/_docker", "invalid reference format"],
		["dock..er/docker", "invalid reference format"],
		["dock_.er/docker", "invalid reference format"],
		["dock-.er/docker", "invalid reference format"],
		["docker/", "invalid reference format"],
		[
			"this_is_not_a_valid_namespace_because_its_lenth_is_greater_than_255_this_is_not_a_valid_namespace_because_its_lenth_is_greater_than_255_this_is_not_a_valid_namespace_because_its_lenth_is_greater_than_255_this_is_not_a_valid_namespace_because_its_lenth_is_greater_than_255/docker",
			"repository name must not be more than 255 characters",
		],
	])("returns the normalize error for %s", (input, expectedMessage) => {
		const [, err] = parseNormalizedNamed(input);

		expect(err?.message).toBe(expectedMessage);
	});
});
