import { once } from "events";
import type { Etcd, Lock } from "./etcd";

export interface WithLockOptions {
	timeoutMs?: number;
}

export async function withLock<T>(
	etcd: Etcd,
	key: string,
	options: WithLockOptions,
	fn: () => T | Promise<T>,
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? 5000;
	const ttlSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
	const deadline = etcd.clock.nowMs() + timeoutMs;

	for (;;) {
		const lock = await tryAcquire(etcd, key, ttlSeconds);
		if (lock) {
			return await runWithLock(lock, fn);
		}

		const remainingMs = deadline - etcd.clock.nowMs();
		if (remainingMs <= 0) {
			throw new Error(`timed out waiting for lock ${key}`);
		}
		const acquired = await waitForLockDeleteOrAcquire(etcd, key, remainingMs, ttlSeconds);
		if (acquired) {
			return await runWithLock(acquired, fn);
		}
	}
}

async function runWithLock<T>(lock: Lock, fn: () => T | Promise<T>): Promise<T> {
	try {
		return await fn();
	} finally {
		await lock.release();
	}
}

async function tryAcquire(etcd: Etcd, key: string, ttlSeconds: number): Promise<Lock | undefined> {
	try {
		return await etcd.lock(key).ttl(ttlSeconds).acquire();
	} catch (error) {
		if (!isLockAcquireFailure(error)) {
			throw error;
		}
		return undefined;
	}
}

function isLockAcquireFailure(error: unknown): boolean {
	return error instanceof Error && /Failed to acquire a lock/.test(error.message);
}

async function waitForLockDeleteOrAcquire(
	etcd: Etcd,
	key: string,
	timeoutMs: number,
	ttlSeconds: number,
): Promise<Lock | undefined> {
	const watcher = await etcd.watch().key(key).only("delete").create();
	try {
		const lock = await tryAcquire(etcd, key, ttlSeconds);
		if (lock) {
			return lock;
		}
		await Promise.race([once(watcher, "delete"), etcd.clock.wait(timeoutMs)]);
		return undefined;
	} finally {
		await watcher.cancel();
	}
}
