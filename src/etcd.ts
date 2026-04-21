// In-memory fake etcd client, modeled after https://github.com/microsoft/etcd3.
//
// PURPOSE
// Used in place of a real etcd3 client in browser-based demos where a live etcd
// server is unavailable. The goal is to be a faithful enough stand-in that code
// written against this is somewhat realistic.
//
// WHAT IS IMPLEMENTED
// - get / getAll: point reads, prefix/range queries, historical reads via
//   revision(), sort, limit, countOnly, keysOnly, min/maxModRevision, and
//   min/maxCreateRevision filters.
// - put: value writes, touch (modRevision bump without value change),
//   getPrevious.
// - delete: single key, prefix, and range deletes with getPrevious.
// - watch: key/prefix/range watches, startRevision replay, event filters
//   (only), withPreviousKV, cancel. Each mutation gets a globally
//   unique revision, matching real etcd semantics.
// - namespace: prefix isolation, arbitrarily nestable.
// - Revision compaction: retainedRevisions option bounds per-key history.
//   A global compaction watermark ensures reads and watches against any
//   compacted revision throw errCompacted, even on empty ranges.
//
// WHAT IS NOT IMPLEMENTED (and why)
// - Leases: lease(), put().lease(), put().ignoreLease(). Requires TTL tracking
//   and a keepalive loop — unnecessary for the scenarios this fake covers.
// - Distributed lock: lock(). Built on leases; same reasoning.
// - Transactions: if()/then()/else()/commit(), and the op() helpers on Put and
//   Delete builders. Requires multi-key atomic compare-and-swap; too complex
//   for current needs.
// - STM (software transactional memory): stm(). Built on transactions.
// - Elections: election(). Built on leases and transactions.
// - Auth/admin: getRoles(), getUsers(), role(), user(). Not relevant to the
//   use cases this fake is designed for.

import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { Clock } from "./clock";
import { SortedMap } from "./collections";

const zeroKey = "\0";

export type Rangable =
	| Range
	| string
	| Buffer
	| { start: string | Buffer; end: string | Buffer }
	| { prefix: string | Buffer };

export interface ResponseHeader {
	cluster_id: string;
	member_id: string;
	revision: string;
	raft_term: string;
}

export interface KeyValue {
	key: Buffer;
	value: Buffer;
	create_revision: string;
	mod_revision: string;
	version: string;
	lease: string;
}

export interface RangeResponse {
	header: ResponseHeader;
	kvs: KeyValue[];
	count: string;
	more: boolean;
}

export interface PutResponse {
	header: ResponseHeader;
	prev_kv?: KeyValue;
}

export interface DeleteResponse {
	header: ResponseHeader;
	deleted: string;
	prev_kvs: KeyValue[];
}

export type WatchEventType = "Put" | "Delete";

export interface WatchEvent {
	type: WatchEventType;
	kv: KeyValue;
	prev_kv: KeyValue | null;
}

export interface WatchResponse {
	header: ResponseHeader;
	watch_id: string;
	created: boolean;
	canceled: boolean;
	compact_revision: string;
	cancel_reason: string;
	events: WatchEvent[];
}

export type SortTarget = "Key" | "Version" | "Create" | "Mod" | "Value";
export type SortOrder = "None" | "Ascend" | "Descend";
export type WatchOperation = "put" | "delete";

interface StoredValue {
	key: string;
	value: string;
	createRevision: number;
	modRevision: number;
	version: number;
}

interface StoredRevision {
	key: string;
	value?: string;
	createRevision: number;
	modRevision: number;
	version: number;
	deleted: boolean;
	historyRevision: number;
}

interface RangeOptions {
	key: string;
	rangeEnd: string;
	limit: number;
	revision?: number;
	sortTarget: SortTarget;
	sortOrder: SortOrder;
	keysOnly: boolean;
	countOnly: boolean;
	minModRevision?: number;
	maxModRevision?: number;
	minCreateRevision?: number;
	maxCreateRevision?: number;
}

interface DeleteOptions {
	key: string;
	rangeEnd: string;
	prevKv: boolean;
}

interface PutOptions {
	key: string;
	value?: string;
	prevKv: boolean;
	ignoreValue: boolean;
}

interface WatchOptions {
	key: string;
	rangeEnd: string;
	startRevision?: number;
	prevKv: boolean;
	filters: Set<"Put" | "Delete">;
}

interface RevisionEvent {
	revision: number;
	event: WatchEvent;
}

interface SortKey {
	primary: string | number;
	key: string;
}

interface EtcdOptions {
	retainedRevisions?: number;
}

export class EtcdError extends Error {
	constructor(
		message: string,
		public readonly code:
			| "errEmptyKey"
			| "errCompacted"
			| "errFutureRev"
			| "errInvalidRange"
			| "errInvalidArgument"
			| "errUnsupported"
			| "errClosed",
	) {
		super(message);
		this.name = "EtcdError";
	}
}

export class Range {
	/** Prefix returns a Range that maps to all keys prefixed with the provided string. */
	public static prefix(prefix: string | Buffer): Range {
		const p = typeof prefix === "string" ? prefix : prefix.toString();
		return new Range(p, prefixRangeEnd(p));
	}

	/** Converts a rangable into a qualified Range. */
	public static from(value: Rangable): Range {
		if (value instanceof Range) {
			return value;
		}
		if (typeof value === "string" || Buffer.isBuffer(value)) {
			return new Range(value);
		}
		if (isPrefixRangable(value)) {
			return Range.prefix(value.prefix);
		}
		if (isBoundedRangable(value)) {
			return new Range(value.start, value.end);
		}
		throw new EtcdError("Invalid range value", "errInvalidRange");
	}

	public readonly start: Buffer;
	public readonly end: Buffer;

	constructor(start: string | Buffer, end: string | Buffer = emptyBuffer) {
		this.start = Buffer.isBuffer(start) ? start : Buffer.from(start);
		this.end = Buffer.isBuffer(end) ? end : Buffer.from(end);
	}

	/**
	 * Returns whether the byte range includes the provided value.
	 *
	 * Matches etcd3's Range.includes semantics, where an empty end is treated
	 * as unbounded (from start to infinity). Note this diverges from etcd's
	 * wire protocol, where an empty range_end means a single-key match — the
	 * wire semantics are preserved inside internal read/watch handling, and
	 * this helper follows the etcd3 convention for compatibility with code
	 * written against real Range.includes().
	 */
	public includes(value: string | Buffer): boolean {
		const v = Buffer.isBuffer(value) ? value : Buffer.from(value);
		return compareBuffers(this.start, v) <= 0 && compareBuffers(this.end, v) > 0;
	}

	/**
	 * Compares the other range to this one (matches etcd3 Range API):
	 *  -1 if this range comes before the other one
	 *  1 if this range comes after the other one
	 *  0 if they overlap
	 */
	public compare(other: Range): number {
		const ivbCmpBegin = compareBuffers(this.start, other.start);
		const ivbCmpEnd = compareBuffers(this.start, other.end);
		const iveCmpBegin = compareBuffers(this.end, other.start);
		if (ivbCmpBegin < 0 && iveCmpBegin <= 0) {
			return -1;
		}
		if (ivbCmpEnd >= 0) {
			return 1;
		}
		return 0;
	}
}

const emptyBuffer = Buffer.alloc(0);

// Byte-wise compare matching etcd's key ordering. A zero-length Buffer is
// treated as positive infinity, so an unbounded end (empty Buffer) sorts
// greater than any key and an unbounded start sorts greater too — this is
// the convention etcd3's Range API uses.
function compareBuffers(a: Buffer, b: Buffer): number {
	if (a.length === 0) {
		return b.length === 0 ? 0 : 1;
	}
	if (b.length === 0) {
		return -1;
	}
	return a.compare(b);
}

function isPrefixRangable(value: unknown): value is { prefix: string | Buffer } {
	return typeof value === "object" && value !== null && "prefix" in value;
}

function isBoundedRangable(value: unknown): value is { start: string | Buffer; end: string | Buffer } {
	return typeof value === "object" && value !== null && "start" in value && "end" in value;
}

abstract class PromiseWrap<T> implements PromiseLike<T> {
	// oxlint-disable-next-line unicorn/no-thenable - intentional etcd3-compatible promise-like builder API
	public then<R1 = T, R2 = never>(
		onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
		onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
	): Promise<R1 | R2> {
		return this.createPromise().then(onFulfilled ?? undefined, onRejected ?? undefined);
	}

	public catch<R>(onRejected: (reason: unknown) => R | PromiseLike<R>): Promise<T | R> {
		return this.createPromise().catch(onRejected);
	}

	protected abstract createPromise(): Promise<T>;
}

class FakeState {
	private revision = 0;
	private nextWatchId = 1;
	// Highest revision that has been globally compacted. Any read or watch at
	// a revision <= this value throws errCompacted, even for ranges with no
	// matching keys, matching real etcd's global compaction watermark.
	private compactedRevision = 0;

	private readonly histories = new SortedMap<string, StoredRevision[]>((l, r) => l.localeCompare(r));
	private readonly history = new SortedMap<number, RevisionEvent>((l, r) => l - r);
	private readonly watchers = new Set<WatcherImpl>();

	constructor(
		private readonly clock: Clock,
		private readonly options: Required<EtcdOptions>,
	) {}

	public range(namespace: string, options: RangeOptions): RangeResponse {
		this.assertValidRange(options.key, options.rangeEnd);

		const revision = this.resolveRevision(options.revision);
		if (options.revision != null && options.revision > 0) {
			this.assertRangeRevisionAvailable(
				namespacedKey(namespace, options.key),
				namespacedRangeEnd(namespace, options.rangeEnd),
				revision,
			);
		}
		const ordered = new SortedMap<SortKey, StoredValue>((left, right) =>
			compareSortKeys(left, right, options.sortOrder),
		);

		for (const [, revisions] of iterateRange(
			this.histories,
			namespacedKey(namespace, options.key),
			namespacedRangeEnd(namespace, options.rangeEnd),
		)) {
			const value = this.resolveStoredValueAt(revisions, revision);
			if (!value) {
				continue;
			}
			if (!passesRangeFilters(value, options)) {
				continue;
			}
			ordered.set(makeSortKey(value, options.sortTarget), cloneStoredValue(value));
		}

		const count = ordered.size;
		const kvs: KeyValue[] = [];
		for (const [, value] of ordered.entries()) {
			if (options.limit > 0 && kvs.length >= options.limit) {
				break;
			}
			if (!options.countOnly) {
				kvs.push(toPublicKv(value, namespace, options.keysOnly));
			}
		}

		return {
			header: this.header(revision),
			kvs,
			count: String(count),
			more: options.limit > 0 && count > options.limit,
		};
	}

	public put(namespace: string, options: PutOptions): PutResponse {
		this.assertNonEmptyKey(options.key);

		const key = namespacedKey(namespace, options.key);
		const existing = currentValue(this.histories.get(key) ?? []);

		if (options.ignoreValue && !existing) {
			throw new EtcdError("etcdserver: key not found", "errInvalidArgument");
		}
		const revision = this.bumpRevision();
		const nextValue: StoredValue = {
			key,
			value: options.ignoreValue && existing ? existing.value : (options.value ?? ""),
			createRevision: existing?.createRevision ?? revision,
			modRevision: revision,
			version: (existing?.version ?? 0) + 1,
		};

		const record = this.appendRevision(
			key,
			{
				key,
				value: nextValue.value,
				createRevision: nextValue.createRevision,
				modRevision: revision,
				version: nextValue.version,
			},
			{
				type: "Put",
				kv: toPublicKv(nextValue, ""),
				prev_kv: existing ? toPublicKv(existing, "") : null,
			},
		);
		this.publish(record);

		return {
			header: this.header(revision),
			prev_kv: options.prevKv ? (existing ? toPublicKv(existing, namespace) : undefined) : undefined,
		};
	}

	public delete(namespace: string, options: DeleteOptions): DeleteResponse {
		this.assertValidRange(options.key, options.rangeEnd);

		const deleted: StoredValue[] = [];
		for (const [, revisions] of iterateRange(
			this.histories,
			namespacedKey(namespace, options.key),
			namespacedRangeEnd(namespace, options.rangeEnd),
		)) {
			const current = currentValue(revisions);
			if (current) {
				deleted.push(cloneStoredValue(current));
			}
		}

		if (deleted.length === 0) {
			return {
				header: this.header(),
				deleted: "0",
				prev_kvs: [],
			};
		}

		// Each deleted key gets its own revision bump, diverging from real etcd
		// where a DeleteRange is a single transaction with one shared revision.
		// This simplification avoids the need for batch transactions and is
		// acceptable for the demo scenarios this fake supports.
		for (const value of deleted) {
			const revision = this.bumpRevision();
			const absolutePrevKv = toPublicKv(value, "");
			const record = this.appendRevision(
				value.key,
				{
					key: value.key,
					value: undefined,
					createRevision: value.createRevision,
					modRevision: revision,
					version: value.version,
					deleted: true,
				},
				{
					type: "Delete",
					kv: { ...absolutePrevKv, mod_revision: String(revision) },
					prev_kv: absolutePrevKv,
				},
			);
			this.publish(record);
		}

		return {
			header: this.header(),
			deleted: String(deleted.length),
			prev_kvs: options.prevKv ? deleted.map((value) => toPublicKv(value, namespace)) : [],
		};
	}

	public watch(namespace: string, options: WatchOptions): Watcher {
		this.assertValidRange(options.key, options.rangeEnd);

		const watchId = this.nextWatchId++;
		const watcher = new WatcherImpl(this, watchId, namespace, options);
		this.watchers.add(watcher);

		this.clock.queueMicrotask(() => {
			if (options.startRevision == null || options.startRevision <= 0) {
				watcher.connect(this.header());
				return;
			}
			const compactRevision = this.compactedRevisionForRange(
				namespacedKey(namespace, options.key),
				namespacedRangeEnd(namespace, options.rangeEnd),
				options.startRevision,
			);
			if (compactRevision !== undefined) {
				watcher.connect(this.header());
				this.clock.setTimeout(() => {
					watcher.fail(new EtcdError("Watcher canceled: ", "errCompacted"), this.header(), {
						compactRevision,
					});
				}, 0);
				return;
			}

			watcher.connect(this.header());
			for (const [, record] of this.history.entriesFrom(options.startRevision)) {
				watcher.handle(record);
			}
		});

		return watcher;
	}

	public cancelWatcher(watcher: WatcherImpl): Promise<void> {
		return new Promise<void>((resolve) => {
			this.clock.queueMicrotask(() => {
				watcher.end();
				resolve();
			});
		});
	}

	public detachWatcher(watcher: WatcherImpl): void {
		this.watchers.delete(watcher);
	}

	public header(revision = this.revision): ResponseHeader {
		return {
			cluster_id: "0",
			member_id: "0",
			revision: String(revision),
			raft_term: "0",
		};
	}

	public close(): void {
		this.watchers.clear();
	}

	public compact(requestedRevision: number): void {
		const revision = this.resolveRevision(requestedRevision);
		if (revision <= 0) {
			return;
		}
		this.compactedRevision = Math.max(this.compactedRevision, revision);
		for (const [historyRevision] of this.history.entries()) {
			if (historyRevision > revision) {
				break;
			}
			this.history.delete(historyRevision);
		}
	}

	private resolveRevision(requestedRevision?: number): number {
		if (requestedRevision == null || requestedRevision <= 0) {
			return this.revision;
		}
		if (requestedRevision > this.revision) {
			throw new EtcdError("etcdserver: mvcc: required revision is a future revision", "errFutureRev");
		}
		return requestedRevision;
	}

	private bumpRevision(): number {
		this.revision += 1;
		return this.revision;
	}

	private appendRevision(
		key: string,
		revision: Omit<StoredRevision, "historyRevision" | "deleted"> & { deleted?: boolean },
		event: WatchEvent,
	): RevisionEvent {
		const record: RevisionEvent = {
			revision: revision.modRevision,
			event,
		};
		this.history.set(revision.modRevision, record);
		const revisions = [...(this.histories.get(key) ?? [])];
		revisions.push({
			...revision,
			deleted: revision.deleted ?? false,
			historyRevision: revision.modRevision,
		});
		while (revisions.length > this.options.retainedRevisions) {
			const removed = revisions.shift();
			if (removed) {
				this.history.delete(removed.historyRevision);
				this.compactedRevision = Math.max(this.compactedRevision, removed.historyRevision);
			}
		}
		this.histories.set(key, revisions);
		return record;
	}

	private publish(record: RevisionEvent): void {
		for (const watcher of this.watchers) {
			watcher.handle(record);
		}
	}

	private resolveStoredValueAt(revisions: StoredRevision[], revision: number): StoredValue | undefined {
		const resolved = findRevisionAtOrBefore(revisions, revision);
		if (!resolved || resolved.deleted) {
			return undefined;
		}
		return {
			key: resolved.key,
			value: resolved.value ?? "",
			createRevision: resolved.createRevision,
			modRevision: resolved.modRevision,
			version: resolved.version,
		};
	}

	private assertRangeRevisionAvailable(start: string, rangeEnd: string, revision: number): void {
		const compactRevision = this.compactedRevisionForRange(start, rangeEnd, revision);
		if (compactRevision !== undefined) {
			throw new EtcdError("etcdserver: mvcc: required revision has been compacted", "errCompacted");
		}
	}

	private compactedRevisionForRange(_start: string, _rangeEnd: string, revision: number): number | undefined {
		if (revision <= 0) {
			return undefined;
		}
		// Compaction is a global property: any revision up to compactedRevision is
		// inaccessible, even on ranges that have no matching keys. A key whose
		// oldest retained revision is later than the requested revision is not
		// "compacted" — it simply did not exist yet, and real etcd would return
		// no kvs rather than errCompacted.
		if (revision <= this.compactedRevision) {
			return this.compactedRevision;
		}
		return undefined;
	}

	private assertNonEmptyKey(key: string): void {
		if (key.length === 0) {
			throw new EtcdError("etcdserver: key is not provided", "errEmptyKey");
		}
	}

	private assertValidRange(key: string, rangeEnd: string): void {
		if (key.length === 0 && rangeEnd !== zeroKey) {
			throw new EtcdError("etcdserver: key is not provided", "errEmptyKey");
		}
	}
}

class Namespace {
	constructor(
		protected readonly state: FakeState,
		protected readonly prefix: string,
	) {}

	/** `.get()` starts a query to look up a single key from etcd. */
	public get(key: string | Buffer): SingleRangeBuilder {
		return new SingleRangeBuilder(this.state, this.prefix, typeof key === "string" ? key : key.toString());
	}

	/** `.getAll()` starts a query to look up multiple keys from etcd. */
	public getAll(): MultiRangeBuilder {
		return new MultiRangeBuilder(this.state, this.prefix);
	}

	/** `.put()` starts making a put request against etcd. */
	public put(key: string | Buffer): PutBuilder {
		return new PutBuilder(this.state, this.prefix, typeof key === "string" ? key : key.toString());
	}

	/** `.delete()` starts making a delete request against etcd. */
	public delete(): DeleteBuilder {
		return new DeleteBuilder(this.state, this.prefix);
	}

	/** `.watch()` creates a new watch builder. See the documentation on the WatchBuilder for usage examples. */
	public watch(): WatchBuilder {
		return new WatchBuilder(this.state, this.prefix);
	}

	/** Creates a structure representing an etcd range. Used in permission grants and queries. This is a convenience method for `Etcd3.Range.from(...)`. */
	public range(value: Rangable): Range {
		return Range.from(value);
	}

	/**
	 * namespace adds a prefix and returns a new Namespace, which is used for
	 * operating on keys in a prefixed domain. For example, if the current
	 * namespace is the default "" and you call namespace('user1/'), all
	 * operations on that new namespace will be automatically prefixed
	 * with `user1/`. See the Namespace class for more details.
	 */
	public namespace(prefix: string | Buffer): Namespace {
		const p = typeof prefix === "string" ? prefix : prefix.toString();
		return new Namespace(this.state, this.prefix + p);
	}

	/** `lease()` is a stub that throws errUnsupported. Leases require TTL tracking and keepalive loops. */
	public lease(_ttl: number, _options?: unknown): never {
		throw new EtcdError("lease() is not implemented in the fake etcd", "errUnsupported");
	}

	/** `lock()` is a helper to provide distributed locking capability. See the documentation on the Lock class for more information and examples. */
	public lock(_key: string | Buffer): never {
		throw new EtcdError("lock() is not implemented in the fake etcd", "errUnsupported");
	}

	/** `stm()` creates a new software transaction, see more details about how this works and why you might find this useful on the SoftwareTransaction class. */
	public stm(_options?: unknown): never {
		throw new EtcdError("stm() is not implemented in the fake etcd", "errUnsupported");
	}

	/** `if()` starts a new etcd transaction, which allows you to execute complex statements atomically. See documentation on the ComparatorBuilder for more information. */
	public if(_key: string | Buffer, _column: string, _cmp: string, _value: string | Buffer | number): never {
		throw new EtcdError("if() is not implemented in the fake etcd", "errUnsupported");
	}

	/** Creates a new {@link Election} instead. See more information on the Election class documentation. */
	public election(_name: string, _ttl?: number): never {
		throw new EtcdError("election() is not implemented in the fake etcd", "errUnsupported");
	}
}

export class Etcd extends Namespace {
	private readonly stateRef: FakeState;
	public readonly kv: {
		compact: (request: { revision: number | string; physical?: boolean }) => Promise<{ header: ResponseHeader }>;
	};

	constructor(clock: Clock, options?: EtcdOptions) {
		const state = new FakeState(clock, {
			retainedRevisions: Math.max(1, options?.retainedRevisions ?? 3),
		});
		super(state, "");
		this.stateRef = state;
		this.kv = {
			compact: async ({ revision }) => {
				this.stateRef.compact(Number(revision));
				return { header: this.stateRef.header() };
			},
		};
	}

	/** Frees resources associated with the client. */
	public close(): void {
		this.stateRef.close();
	}
}

abstract class RangeBuilder<T> extends PromiseWrap<T> {
	protected readonly request: RangeOptions = {
		key: "",
		rangeEnd: "",
		limit: 0,
		sortTarget: "Key",
		sortOrder: "None",
		keysOnly: false,
		countOnly: false,
	};

	constructor(
		protected readonly state: FakeState,
		protected readonly namespace: string,
	) {
		super();
	}

	/** revision is the point-in-time of the key-value store to use for the range. */
	public revision(revision: number | string): this {
		this.request.revision = Number(revision);
		return this;
	}

	/** minModRevision sets the minimum modified revision of keys to return. */
	public minModRevision(revision: number | string): this {
		this.request.minModRevision = Number(revision);
		return this;
	}

	/** maxModRevision sets the maximum modified revision of keys to return. */
	public maxModRevision(revision: number | string): this {
		this.request.maxModRevision = Number(revision);
		return this;
	}

	/** minCreateRevision sets the minimum create revision of keys to return. */
	public minCreateRevision(revision: number | string): this {
		this.request.minCreateRevision = Number(revision);
		return this;
	}

	/** maxCreateRevision sets the maximum create revision of keys to return. */
	public maxCreateRevision(revision: number | string): this {
		this.request.maxCreateRevision = Number(revision);
		return this;
	}
}

export class SingleRangeBuilder extends RangeBuilder<string | null> {
	constructor(state: FakeState, namespace: string, key: string) {
		super(state, namespace);
		this.request.key = key;
		this.request.rangeEnd = "";
		this.request.limit = 1;
	}

	/** Runs the built request and parses the returned key as JSON, or returns `null` if it isn't found. */
	public async json(): Promise<unknown> {
		// @ts-expect-error this mimics the microsoft/etcd3 behaviour
		return await this.string().then(JSON.parse);
	}

	/** Runs the built request and returns the value of the returned key as a string, or `null` if it isn't found. */
	public async string(): Promise<string | null> {
		const response = await this.exec();
		return response.kvs[0]?.value.toString() ?? null;
	}

	/** Runs the built request and returns the value as a Buffer, or `null` if it isn't found. */
	public async buffer(): Promise<Buffer | null> {
		const response = await this.exec();
		return response.kvs[0]?.value ?? null;
	}

	/** Runs the built request, and returns the value parsed as a number. Resolves as NaN if the value can't be parsed as a number. */
	public async number(): Promise<number | null> {
		const value = await this.string();
		return value === null ? null : Number(value);
	}

	/** Returns whether the key exists. */
	public async exists(): Promise<boolean> {
		this.request.keysOnly = true;
		return Number(await this.exec().then((r) => r.count)) > 0;
	}

	/** Runs the built request and returns the raw response from etcd. */
	public async exec(): Promise<RangeResponse> {
		return this.state.range(this.namespace, this.request);
	}

	/** No-op serializable flag (matches etcd3 API). */
	public serializable(_s: boolean): this {
		return this;
	}

	/** No-op options (matches etcd3 API). */
	public options(_options: unknown): this {
		return this;
	}

	/** op() is not implemented in the fake etcd. */
	public op(): never {
		throw new EtcdError("op() is not implemented in the fake etcd", "errUnsupported");
	}

	protected createPromise(): Promise<string | null> {
		return this.string();
	}
}

export class MultiRangeBuilder extends RangeBuilder<Record<string, string>> {
	constructor(state: FakeState, namespace: string) {
		super(state, namespace);
		this.prefix("");
	}

	/** Prefix instructs the query to scan for all keys that have the provided prefix. */
	public prefix(value: string | Buffer): this {
		return this.inRange(Range.prefix(typeof value === "string" ? value : value.toString()));
	}

	/** inRange instructs the builder to get keys in the specified byte range. */
	public inRange(value: Rangable): this {
		const range = Range.from(value);
		this.request.key = range.start.toString();
		this.request.rangeEnd = range.end.toString();
		return this;
	}

	/** All will instruct etcd to get all keys. */
	public all(): this {
		return this.prefix("");
	}

	/** Limit sets the maximum number of results to retrieve. */
	public limit(count: number): this {
		this.request.limit = Number.isFinite(count) ? count : 0;
		return this;
	}

	/** Sort specifies how the result should be sorted. */
	public sort(target: SortTarget, order: SortOrder): this {
		this.request.sortTarget = target;
		this.request.sortOrder = order;
		return this;
	}

	/** count returns the number of keys that match the query. */
	public async count(): Promise<number> {
		this.request.countOnly = true;
		return Number((await this.exec()).count);
	}

	/** Keys returns an array of keys matching the query. */
	public async keys(): Promise<string[]> {
		this.request.keysOnly = true;
		return (await this.exec()).kvs.map((kv) => kv.key.toString());
	}

	/** Returns keys as Buffers. */
	public async keyBuffers(): Promise<Buffer[]> {
		this.request.keysOnly = true;
		return (await this.exec()).kvs.map((kv) => kv.key);
	}

	/** Runs the built request and parses the returned keys as JSON. */
	public async json(): Promise<Record<string, unknown>> {
		return this.mapValues(JSON.parse);
	}

	/** Runs the built request and returns the values of returned keys as strings. */
	public async strings(): Promise<Record<string, string>> {
		return this.mapValues((value) => value);
	}

	/** Runs the built request and returns the values of keys as numbers. May resolve to NaN if the keys do not contain numbers. */
	public async numbers(): Promise<Record<string, number>> {
		return this.mapValues((value) => Number(value));
	}

	/** Returns values as Buffers. */
	public async buffers(): Promise<Record<string, Buffer>> {
		const output: Record<string, Buffer> = {};
		for (const kv of (await this.exec()).kvs) {
			output[kv.key.toString()] = kv.value;
		}
		return output;
	}

	/** Runs the built request and returns the raw response from etcd. */
	public async exec(): Promise<RangeResponse> {
		return this.state.range(this.namespace, this.request);
	}

	/** No-op options (matches etcd3 API). */
	public options(_options: unknown): this {
		return this;
	}

	/** op() is not implemented in the fake etcd. */
	public op(): never {
		throw new EtcdError("op() is not implemented in the fake etcd", "errUnsupported");
	}

	protected createPromise(): Promise<Record<string, string>> {
		return this.strings();
	}

	private async mapValues<T>(mapValue: (value: string) => T): Promise<Record<string, T>> {
		const output: Record<string, T> = {};
		for (const kv of (await this.exec()).kvs) {
			output[kv.key.toString()] = mapValue(kv.value.toString());
		}
		return output;
	}
}

export class PutBuilder extends PromiseWrap<PutResponse> {
	private readonly request: PutOptions;

	constructor(
		private readonly state: FakeState,
		private readonly namespace: string,
		key: string,
	) {
		super();
		this.request = {
			key,
			prevKv: false,
			ignoreValue: false,
		};
	}

	/** value sets the value that will be stored in the key. */
	public value(value: string | Buffer | number): this {
		if (Buffer.isBuffer(value)) {
			this.request.value = value.toString();
		} else {
			this.request.value = String(value);
		}
		return this;
	}

	/** lease() is not implemented in the fake etcd. */
	public lease(_lease: number | string | Promise<string | number>): this {
		throw new EtcdError("lease() is not implemented in the fake etcd", "errUnsupported");
	}

	/** ignoreLease() is not implemented in the fake etcd. */
	public ignoreLease(): this {
		throw new EtcdError("ignoreLease() is not implemented in the fake etcd", "errUnsupported");
	}

	/** No-op options (matches etcd3 API). */
	public options(_options: unknown): this {
		return this;
	}

	/**
	 * getPrevious instructs etcd to *try* to get the previous value of the
	 * key before setting it. One may not always be available if a compaction
	 * takes place.
	 *
	 * Matches the etcd3 API which merges the previous KV with the response
	 * header into a single object.
	 */
	public async getPrevious(): Promise<(KeyValue & { header: ResponseHeader }) | undefined> {
		this.request.prevKv = true;
		const res = await this.exec();
		return res.prev_kv ? { ...res.prev_kv, header: res.header } : undefined;
	}

	/** Touch updates the key's revision without changing its value. This is equivalent to the etcd 'ignore value' flag. */
	public async touch(): Promise<PutResponse> {
		this.request.ignoreValue = true;
		this.request.value = undefined;
		return this.exec();
	}

	/** exec runs the put request. */
	public async exec(): Promise<PutResponse> {
		return this.state.put(this.namespace, this.request);
	}

	/** op() is not implemented in the fake etcd. */
	public op(): never {
		throw new EtcdError("op() is not implemented in the fake etcd", "errUnsupported");
	}

	protected createPromise(): Promise<PutResponse> {
		return this.exec();
	}
}

export class DeleteBuilder extends PromiseWrap<DeleteResponse> {
	private readonly request: DeleteOptions = {
		key: "",
		rangeEnd: "",
		prevKv: false,
	};

	constructor(
		private readonly state: FakeState,
		private readonly namespace: string,
	) {
		super();
	}

	/** key sets a single key to be deleted. */
	public key(value: string | Buffer): this {
		this.request.key = typeof value === "string" ? value : value.toString();
		this.request.rangeEnd = "";
		return this;
	}

	/** Prefix instructs the query to delete all keys with the given prefix. */
	public prefix(value: string | Buffer): this {
		return this.inRange(Range.prefix(typeof value === "string" ? value : value.toString()));
	}

	/** Sets the byte range of values to delete. */
	public range(range: Range): this {
		this.request.key = range.start.toString();
		this.request.rangeEnd = range.end.toString();
		return this;
	}

	/** All will instruct etcd to wipe all keys. */
	public all(): this {
		return this.prefix("");
	}

	/** inRange instructs the builder to delete keys in the specified byte range. */
	public inRange(value: Rangable): this {
		const range = Range.from(value);
		this.request.key = range.start.toString();
		this.request.rangeEnd = range.end.toString();
		return this;
	}

	/**
	 * getPrevious instructs etcd to *try* to get the previous value of the
	 * key before deleting it. One may not always be available if a compaction
	 * takes place.
	 */
	public async getPrevious(): Promise<KeyValue[]> {
		this.request.prevKv = true;
		return (await this.exec()).prev_kvs;
	}

	/** exec runs the delete request. */
	public async exec(): Promise<DeleteResponse> {
		return this.state.delete(this.namespace, this.request);
	}

	/** No-op options (matches etcd3 API). */
	public options(_options: unknown): this {
		return this;
	}

	/** op() is not implemented in the fake etcd. */
	public op(): never {
		throw new EtcdError("op() is not implemented in the fake etcd", "errUnsupported");
	}

	protected createPromise(): Promise<DeleteResponse> {
		return this.exec();
	}
}

export class WatchBuilder {
	private readonly request: WatchOptions = {
		key: "",
		rangeEnd: "",
		prevKv: false,
		filters: new Set(),
	};

	constructor(
		private readonly state: FakeState,
		private readonly namespace: string,
	) {}

	/** Sets a single key to be watched. */
	public key(key: string | Buffer): this {
		this.request.key = typeof key === "string" ? key : key.toString();
		this.request.rangeEnd = "";
		return this;
	}

	/** Prefix instructs the watcher to watch all keys with the given prefix. */
	public prefix(value: string | Buffer): this {
		return this.inRange(Range.prefix(typeof value === "string" ? value : value.toString()));
	}

	/** inRange instructs the builder to watch keys in the specified byte range. */
	public inRange(value: Rangable): this {
		const range = Range.from(value);
		this.request.key = range.start.toString();
		this.request.rangeEnd = range.end.toString();
		return this;
	}

	/**
	 * Requests only changes for the given kind of operation: `"put"` or
	 * `"delete"`. Calling with no arguments means no filter — all events are
	 * received, matching real etcd3 behaviour.
	 *
	 * Passing both `"put"` and `"delete"` matches real etcd3: the underlying
	 * proto filter list becomes `[NODELETE, NOPUT]` which produces a watcher
	 * that never fires.
	 */
	public only(...operations: WatchOperation[]): this {
		// Each argument maps to excluding the complementary type, matching
		// etcd3's FilterType.Nodelete / FilterType.Noput semantics:
		//   only("put")           → exclude deletes
		//   only("delete")        → exclude puts
		//   only("put","delete")  → exclude both, watcher never fires
		//   only()                → no exclusions, receive all events
		const ignored = new Set<"Put" | "Delete">();
		for (const op of operations) {
			ignored.add(op === "put" ? "Delete" : "Put");
		}
		this.request.filters = ignored;
		return this;
	}

	/**
	 * ignore() is an alias for only() — deprecated in etcd3 but kept for API compatibility.
	 */
	public ignore(...operations: WatchOperation[]): this {
		return this.only(...operations);
	}

	/** Instructs the watcher to return the previous key/value pair in updates. */
	public withPreviousKV(): this {
		this.request.prevKv = true;
		return this;
	}

	/** Watch starting from a specific revision. */
	public startRevision(revision: string): this {
		this.request.startRevision = Number(revision);
		return this;
	}

	/**
	 * watcher() returns the Watcher synchronously so callers can attach
	 * handlers before the microtask runs — necessary when using startRevision,
	 * since history replay fires during that same microtask.
	 */
	public watcher(): Watcher {
		return this.state.watch(this.namespace, this.request);
	}

	/** Resolves the watch request into a Watcher, and fires off to etcd. */
	public create(): Promise<Watcher> {
		const watcher = this.watcher();
		return Promise.race([
			onceEvent(watcher, "connected").then(() => watcher),
			onceEvent(watcher, "error").then((error) => Promise.reject(error)),
		]);
	}
}

export interface Watcher extends EventEmitter {
	/** id is the watcher ID assigned by etcd, or null before connection. */
	readonly id: string | null;
	/** connecting is fired when the watcher is (re)connecting to etcd. */
	on(event: "connecting", handler: (req: unknown) => void): this;
	/** connected is fired after etcd acknowledges the watcher is connected. When this event is fired, `id` will already be populated. */
	on(event: "connected", handler: (response: WatchResponse) => void): this;
	/** data is fired when etcd reports an update on one of the keys being watched. */
	on(event: "data", handler: (response: WatchResponse) => void): this;
	/** put is fired, in addition to `data`, when a key is created or updated in etcd. */
	on(event: "put", handler: (kv: KeyValue, previous?: KeyValue | null) => void): this;
	/** delete is fired, in addition to `data`, when a key is deleted from etcd. */
	on(event: "delete", handler: (kv: KeyValue, previous?: KeyValue | null) => void): this;
	/** end is fired after the watcher is closed normally. Like Node.js streams, end is NOT fired if `error` is fired. */
	on(event: "end", handler: () => void): this;
	/** disconnected is fired if the watcher is disconnected due to an error. */
	on(event: "disconnected", handler: (res: EtcdError) => void): this;
	/** error is fired if a non-recoverable error occurs that prevents the watcher from functioning. */
	on(event: "error", handler: (error: EtcdError) => void): this;
	/** Cancels the watcher. */
	cancel(): Promise<void>;
}

class WatcherImpl extends EventEmitter implements Watcher {
	private connected = false;
	private ended = false;
	private readonly _watchId: number;
	public readonly id: string | null = null;

	constructor(
		private readonly state: FakeState,
		watchId: number,
		private readonly namespace: string,
		private readonly options: WatchOptions,
	) {
		super();
		this._watchId = watchId;
	}

	public override on(event: "connecting", handler: (req: unknown) => void): this;
	public override on(event: "connected", handler: (response: WatchResponse) => void): this;
	public override on(event: "data", handler: (response: WatchResponse) => void): this;
	public override on(event: "put", handler: (kv: KeyValue, previous?: KeyValue | null) => void): this;
	public override on(event: "delete", handler: (kv: KeyValue, previous?: KeyValue | null) => void): this;
	public override on(event: "end", handler: () => void): this;
	public override on(event: "disconnected", handler: (res: EtcdError) => void): this;
	public override on(event: "error", handler: (error: EtcdError) => void): this;
	public override on(
		event: string,
		handler:
			| ((req: unknown) => void)
			| ((response: WatchResponse) => void)
			| ((kv: KeyValue, previous?: KeyValue | null) => void)
			| ((error: EtcdError) => void)
			| (() => void),
	): this {
		return super.on(event, handler);
	}

	public cancel(): Promise<void> {
		return this.state.cancelWatcher(this);
	}

	public connect(header: ResponseHeader): void {
		if (this.connected || this.ended) {
			return;
		}
		this.connected = true;
		(this as { id: string | null }).id = String(this._watchId);
		this.emit("connected", {
			header,
			watch_id: String(this._watchId),
			created: true,
			canceled: false,
			compact_revision: "0",
			cancel_reason: "",
			events: [],
		} satisfies WatchResponse);
	}

	public handle(record: RevisionEvent): void {
		if (!this.connected || this.ended) {
			return;
		}
		const rangeKey = namespacedKey(this.namespace, this.options.key);
		const rangeEnd = namespacedRangeEnd(this.namespace, this.options.rangeEnd);
		const rawEventKey = record.event.kv.key.toString();
		if (!isKeyInRange(rawEventKey, rangeKey, rangeEnd)) {
			return;
		}
		if (this.options.filters.has(record.event.type)) {
			return;
		}

		const response: WatchResponse = {
			header: this.state.header(record.revision),
			watch_id: String(this._watchId),
			created: false,
			canceled: false,
			compact_revision: "0",
			cancel_reason: "",
			events: [],
		};

		const unprefixed = unprefixKey(rawEventKey, this.namespace);
		const kv: KeyValue = { ...record.event.kv, key: Buffer.from(unprefixed) };
		let prev_kv: KeyValue | null = null;
		if (this.options.prevKv && record.event.prev_kv) {
			const rawPrevKey = record.event.prev_kv.key.toString();
			const unprefixedPrev = unprefixKey(rawPrevKey, this.namespace);
			prev_kv = { ...record.event.prev_kv, key: Buffer.from(unprefixedPrev) };
		}
		response.events.push({
			type: record.event.type,
			kv,
			prev_kv,
		});

		this.emit("data", response);

		const event = response.events[0];
		if (event) {
			// emit lowercase event name to match etcd3 Watcher which emits "put" and "delete"
			this.emit(event.type === "Put" ? "put" : "delete", event.kv, event.prev_kv);
		}
	}

	public fail(error: EtcdError, header: ResponseHeader, extra?: { compactRevision?: number }): void {
		this.state.detachWatcher(this);
		this.connected = false;
		this.emit("error", error);
		this.emit("data", {
			header,
			watch_id: String(this._watchId),
			created: false,
			canceled: true,
			compact_revision: String(extra?.compactRevision ?? 0),
			cancel_reason: error.message,
			events: [],
		} satisfies WatchResponse);
	}

	public disconnect(error: EtcdError): void {
		if (this.ended) {
			return;
		}
		this.ended = true;
		this.state.detachWatcher(this);
		this.connected = false;
		(this as { id: string | null }).id = null;
		this.emit("disconnected", error);
	}

	public end(): void {
		if (this.ended) {
			return;
		}
		this.ended = true;
		this.state.detachWatcher(this);
		this.connected = false;
		this.emit("end");
	}
}

function onceEvent(emitter: EventEmitter, event: string): Promise<unknown> {
	return new Promise<unknown>((resolve, reject) => {
		const onResolve = (value: unknown) => {
			emitter.removeListener("error", onReject);
			resolve(value);
		};
		const onReject = (error: unknown) => {
			emitter.removeListener(event, onResolve);
			reject(error);
		};

		emitter.once(event, onResolve);
		if (event !== "error") {
			emitter.once("error", onReject);
		}
	});
}

function namespacedKey(namespace: string, key: string): string {
	return `${namespace}${key}`;
}

function unprefixKey(key: string, namespace: string): string {
	return namespace && key.startsWith(namespace) ? key.slice(namespace.length) : key;
}

function namespacedRangeEnd(namespace: string, rangeEnd: string): string {
	if (rangeEnd === "") {
		return "";
	}
	if (rangeEnd === zeroKey) {
		return namespace === "" ? zeroKey : prefixRangeEnd(namespace);
	}
	return `${namespace}${rangeEnd}`;
}

function* iterateRange<V>(
	values: SortedMap<string, V>,
	start: string,
	rangeEnd: string,
): Generator<readonly [string, V]> {
	for (const entry of values.entriesFrom(start)) {
		const [key] = entry;
		if (!isKeyInRange(key, start, rangeEnd)) {
			break;
		}
		yield entry;
	}
}

function passesRangeFilters(value: StoredValue, options: RangeOptions): boolean {
	if (options.minModRevision != null && value.modRevision < options.minModRevision) {
		return false;
	}
	if (options.maxModRevision != null && value.modRevision > options.maxModRevision) {
		return false;
	}
	if (options.minCreateRevision != null && value.createRevision < options.minCreateRevision) {
		return false;
	}
	if (options.maxCreateRevision != null && value.createRevision > options.maxCreateRevision) {
		return false;
	}
	return true;
}

function toPublicKv(value: StoredValue, namespace: string, keysOnly = false): KeyValue {
	const key = value.key.startsWith(namespace) ? value.key.slice(namespace.length) : value.key;
	return {
		key: Buffer.from(key),
		value: keysOnly ? Buffer.alloc(0) : Buffer.from(value.value),
		create_revision: String(value.createRevision),
		mod_revision: String(value.modRevision),
		version: String(value.version),
		lease: "",
	};
}

function cloneStoredValue(value: StoredValue): StoredValue {
	return {
		...value,
	};
}

function currentValue(revisions: StoredRevision[]): StoredValue | undefined {
	const last = revisions[revisions.length - 1];
	if (!last || last.deleted) {
		return undefined;
	}
	return {
		key: last.key,
		value: last.value ?? "",
		createRevision: last.createRevision,
		modRevision: last.modRevision,
		version: last.version,
	};
}

function findRevisionAtOrBefore(revisions: StoredRevision[], revision: number): StoredRevision | undefined {
	let low = 0;
	let high = revisions.length - 1;
	let result: StoredRevision | undefined;

	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const candidate = revisions[mid];
		if (!candidate) {
			break;
		}

		if (candidate.modRevision <= revision) {
			result = candidate;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	return result;
}

function compareSortKeys(left: SortKey, right: SortKey, order: SortOrder): number {
	const factor = order === "Descend" ? -1 : 1;
	if (left.primary < right.primary) {
		return -1 * factor;
	}
	if (left.primary > right.primary) {
		return 1 * factor;
	}
	// Secondary sort is always ascending by key, regardless of primary order,
	// matching real etcd's stable tiebreaking behaviour.
	return left.key.localeCompare(right.key);
}

function makeSortKey(value: StoredValue, target: SortTarget): SortKey {
	switch (target) {
		case "Create":
			return { primary: value.createRevision, key: value.key };
		case "Mod":
			return { primary: value.modRevision, key: value.key };
		case "Version":
			return { primary: value.version, key: value.key };
		case "Value":
			return { primary: value.value, key: value.key };
		case "Key":
		default:
			return { primary: value.key, key: value.key };
	}
}

function isKeyInRange(key: string, start: string, rangeEnd: string): boolean {
	if (rangeEnd === "") {
		return key === start;
	}
	if (rangeEnd === zeroKey) {
		return key >= start;
	}
	return key >= start && key < rangeEnd;
}

export function prefixRangeEnd(prefix: string): string {
	if (prefix.length === 0) {
		return zeroKey;
	}

	const chars = Array.from(prefix);
	for (let index = chars.length - 1; index >= 0; index -= 1) {
		const code = chars[index]?.charCodeAt(0);
		if (code == null || code === 0xffff) {
			continue;
		}
		chars[index] = String.fromCharCode(code + 1);
		return chars.slice(0, index + 1).join("");
	}

	return zeroKey;
}
