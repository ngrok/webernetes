/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// Models kubernetes/pkg/util/parsers/parsers.go ParseImageName.
export function parseImageName(
	image: string,
): [repoToPull: string, tag: string, digest: string, err: Error | undefined] {
	const [named, err] = parseNormalizedNamed(image);
	if (err !== undefined) {
		return ["", "", "", new Error(`couldn't parse image name "${image}": ${err.message}`)];
	}

	const repoToPull = named.name();
	let tag = "";
	let digest = "";

	const tagged = asTagged(named);
	if (tagged !== undefined) {
		tag = tagged.tag();
	}

	const digested = asDigested(named);
	if (digested !== undefined) {
		digest = digested.digest();
	}
	if (tag.length === 0 && digest.length === 0) {
		tag = "latest";
	}
	return [repoToPull, tag, digest, undefined];
}

export interface Named {
	name(): string;
	string(): string;
}

export interface Tagged {
	tag(): string;
}

export interface Digested {
	digest(): string;
}

export interface Reference {
	string(): string;
}

interface NamedRepository extends Named {
	domain(): string;
	path(): string;
}

// Models vendor/github.com/distribution/reference/normalize.go ParseNormalizedNamed.
export function parseNormalizedNamed(s: string): [Named, Error | undefined] {
	if (anchoredIdentifierRegexp.test(s)) {
		return [
			emptyNamed,
			new Error(`invalid repository name (${s}), cannot specify 64-byte hexadecimal strings`),
		];
	}
	const [domain, remainder] = splitDockerDomain(s);
	let remote: string;
	const tagSep = remainder.indexOf(":");
	if (tagSep > -1) {
		remote = remainder.slice(0, tagSep);
	} else {
		remote = remainder;
	}
	if (remote.toLowerCase() !== remote) {
		return [
			emptyNamed,
			new Error(`invalid reference format: repository name (${remote}) must be lowercase`),
		];
	}

	const [ref, err] = parse(`${domain}/${remainder}`);
	if (err !== undefined) {
		return [emptyNamed, err];
	}
	const named = asNamed(ref);
	if (named === undefined) {
		return [emptyNamed, new Error(`reference ${ref?.string() ?? ""} has no name`)];
	}

	return [named, undefined];
}

function asTagged(named: Named): Tagged | undefined {
	if (named instanceof TaggedReference || named instanceof ReferenceValue) {
		return named;
	}
	return undefined;
}

function asDigested(named: Named): Digested | undefined {
	if (
		named instanceof CanonicalReference ||
		named instanceof ReferenceValue ||
		named instanceof DigestReference
	) {
		return named;
	}
	return undefined;
}

function asNamed(ref: Reference | undefined): Named | undefined {
	if (
		ref instanceof Repository ||
		ref instanceof TaggedReference ||
		ref instanceof CanonicalReference ||
		ref instanceof ReferenceValue
	) {
		return ref;
	}
	return undefined;
}

// Models vendor/github.com/distribution/reference/reference.go Parse.
export function parse(s: string): [Reference | undefined, Error | undefined] {
	const matches = referenceRegexp.exec(s);
	if (matches === null) {
		if (s === "") {
			return [undefined, errNameEmpty];
		}
		if (referenceRegexp.exec(s.toLowerCase()) !== null) {
			return [undefined, errNameContainsUppercase];
		}
		return [undefined, errReferenceInvalidFormat];
	}

	let repo: Repository;
	const nameMatch = anchoredNameRegexp.exec(matches[1] ?? "");
	if (nameMatch !== null && nameMatch.length === 3) {
		repo = new Repository(nameMatch[1] ?? "", nameMatch[2] ?? "");
	} else {
		repo = new Repository("", matches[1] ?? "");
	}

	if (repo.path().length > repositoryNameTotalLengthMax) {
		return [undefined, errNameTooLong];
	}

	let digest = "";
	if ((matches[3] ?? "") !== "") {
		const [parsedDigest, err] = parseDigest(matches[3] ?? "");
		if (err !== undefined) {
			return [undefined, err];
		}
		digest = parsedDigest;
	}

	const ref = new ReferenceValue(repo, matches[2] ?? "", digest);
	const r = getBestReferenceType(ref);
	if (r === undefined) {
		return [undefined, errNameEmpty];
	}

	return [r, undefined];
}

// Models vendor/github.com/distribution/reference/reference.go getBestReferenceType.
function getBestReferenceType(ref: ReferenceValue): Reference | undefined {
	if (ref.name() === "") {
		if (ref.digest() !== "") {
			return new DigestReference(ref.digest());
		}
		return undefined;
	}
	if (ref.tag() === "") {
		if (ref.digest() !== "") {
			return new CanonicalReference(ref.namedRepository, ref.digest());
		}
		return ref.namedRepository;
	}
	if (ref.digest() === "") {
		return new TaggedReference(ref.namedRepository, ref.tag());
	}

	return ref;
}

class ReferenceValue implements Reference, NamedRepository, Tagged, Digested {
	constructor(
		readonly namedRepository: Repository,
		private readonly tagValue: string,
		private readonly digestValue: string,
	) {}

	string(): string {
		return `${this.name()}:${this.tagValue}@${this.digestValue}`;
	}

	name(): string {
		return this.namedRepository.name();
	}

	domain(): string {
		return this.namedRepository.domain();
	}

	path(): string {
		return this.namedRepository.path();
	}

	tag(): string {
		return this.tagValue;
	}

	digest(): string {
		return this.digestValue;
	}
}

class Repository implements Reference, NamedRepository {
	constructor(
		private readonly domainValue: string,
		private readonly pathValue: string,
	) {}

	string(): string {
		return this.name();
	}

	name(): string {
		if (this.domainValue === "") {
			return this.pathValue;
		}
		return `${this.domainValue}/${this.pathValue}`;
	}

	domain(): string {
		return this.domainValue;
	}

	path(): string {
		return this.pathValue;
	}
}

class DigestReference implements Reference, Digested {
	constructor(private readonly digestValue: string) {}

	string(): string {
		return this.digestValue;
	}

	digest(): string {
		return this.digestValue;
	}
}

class TaggedReference implements Reference, NamedRepository, Tagged {
	constructor(
		private readonly namedRepository: Repository,
		private readonly tagValue: string,
	) {}

	string(): string {
		return `${this.name()}:${this.tagValue}`;
	}

	name(): string {
		return this.namedRepository.name();
	}

	domain(): string {
		return this.namedRepository.domain();
	}

	path(): string {
		return this.namedRepository.path();
	}

	tag(): string {
		return this.tagValue;
	}
}

class CanonicalReference implements Reference, NamedRepository, Digested {
	constructor(
		private readonly namedRepository: Repository,
		private readonly digestValue: string,
	) {}

	string(): string {
		return `${this.name()}@${this.digestValue}`;
	}

	name(): string {
		return this.namedRepository.name();
	}

	domain(): string {
		return this.namedRepository.domain();
	}

	path(): string {
		return this.namedRepository.path();
	}

	digest(): string {
		return this.digestValue;
	}
}

const emptyNamed = new Repository("", "");

// Models vendor/github.com/distribution/reference/normalize.go splitDockerDomain.
function splitDockerDomain(name: string): [domain: string, remoteName: string] {
	const slashIndex = name.indexOf("/");
	if (slashIndex === -1) {
		return [defaultDomain, `${officialRepoPrefix}${name}`];
	}

	const maybeDomain = name.slice(0, slashIndex);
	const maybeRemoteName = name.slice(slashIndex + 1);
	let domain: string;
	let remoteName: string;
	switch (true) {
		case maybeDomain === localhost:
			domain = maybeDomain;
			remoteName = maybeRemoteName;
			break;
		case maybeDomain === legacyDefaultDomain:
			domain = defaultDomain;
			remoteName = maybeRemoteName;
			break;
		case maybeDomain.includes(".") || maybeDomain.includes(":"):
			domain = maybeDomain;
			remoteName = maybeRemoteName;
			break;
		case maybeDomain.toLowerCase() !== maybeDomain:
			domain = maybeDomain;
			remoteName = maybeRemoteName;
			break;
		default:
			domain = defaultDomain;
			remoteName = name;
			break;
	}

	if (domain === defaultDomain && !remoteName.includes("/")) {
		remoteName = `${officialRepoPrefix}${remoteName}`;
	}

	return [domain, remoteName];
}

function parseDigest(s: string): [digest: string, err: Error | undefined] {
	if (!anchoredDigestRegexp.test(s)) {
		return ["", errDigestInvalidFormat];
	}
	const [algorithm, encoded] = s.split(":", 2);
	switch (algorithm) {
		case "sha256":
			if ((encoded ?? "").length !== 64) {
				return ["", new Error("invalid checksum digest length")];
			}
			break;
		case "sha512":
			if ((encoded ?? "").length !== 128) {
				return ["", new Error("invalid checksum digest length")];
			}
			break;
		default:
			return ["", new Error("unsupported digest algorithm")];
	}
	return [s, undefined];
}

function optional(...res: string[]): string {
	return `(?:${res.join("")})?`;
}

function anyTimes(...res: string[]): string {
	return `(?:${res.join("")})*`;
}

function capture(...res: string[]): string {
	return `(${res.join("")})`;
}

function anchored(...res: string[]): string {
	return `^${res.join("")}$`;
}

function compile(pattern: string): RegExp {
	return new RegExp(pattern.replaceAll("[[:xdigit:]]", "[0-9a-fA-F]"));
}

const repositoryNameTotalLengthMax = 255;
const errReferenceInvalidFormat = new Error("invalid reference format");
const errDigestInvalidFormat = new Error("invalid digest format");
const errNameContainsUppercase = new Error("repository name must be lowercase");
const errNameEmpty = new Error("repository name must have at least one component");
const errNameTooLong = new Error(
	`repository name must not be more than ${repositoryNameTotalLengthMax} characters`,
);

const alphanumeric = `[a-z0-9]+`;
const separator = `(?:[._]|__|[-]+)`;
const localhost = `localhost`;
const domainNameComponent = `(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])`;
const optionalPort = `(?::[0-9]+)?`;
const tag = `[\\w][\\w.-]{0,127}`;
const digestPat = `[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*[:][[:xdigit:]]{32,}`;
const identifier = `([a-f0-9]{64})`;
const ipv6address = `\\[(?:[a-fA-F0-9:]+)\\]`;
const domainName = domainNameComponent + anyTimes(`\\.${domainNameComponent}`);
const host = `(?:${domainName}|${ipv6address})`;
const domainAndPort = host + optionalPort;
const pathComponent = alphanumeric + anyTimes(separator + alphanumeric);
const remoteName = pathComponent + anyTimes(`/` + pathComponent);
const namePat = optional(domainAndPort + `/`) + remoteName;
const anchoredNameRegexp = compile(
	anchored(optional(capture(domainAndPort), `/`), capture(remoteName)),
);
const referencePat = anchored(
	capture(namePat),
	optional(`:`, capture(tag)),
	optional(`@`, capture(digestPat)),
);

const referenceRegexp = compile(referencePat);
const anchoredDigestRegexp = compile(anchored(digestPat));
const anchoredIdentifierRegexp = compile(anchored(identifier));

const legacyDefaultDomain = "index.docker.io";
const defaultDomain = "docker.io";
const officialRepoPrefix = "library/";
