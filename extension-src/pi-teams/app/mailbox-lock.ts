import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface LockOwner {
	pid: number;
	identity: string;
	token: string;
}

function processIdentity(pid: number): string | undefined {
	try {
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const end = stat.lastIndexOf(")");
			const startTime = stat.slice(end + 2).split(" ")[19];
			return startTime ? `linux:${startTime}` : undefined;
		}
		if (process.platform === "darwin") {
			const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
			return started ? `darwin:${started}` : undefined;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function readOwner(lock: string): LockOwner | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"pid" in parsed &&
			Number.isSafeInteger(parsed.pid) &&
			"identity" in parsed &&
			typeof parsed.identity === "string" &&
			"token" in parsed &&
			typeof parsed.token === "string"
		)
			return parsed as LockOwner;
	} catch {
		// An owner file may be mid-write; fail closed rather than reclaiming it.
	}
	return undefined;
}

function ownerIsStale(owner: LockOwner): boolean {
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
		return false;
	}
	const currentIdentity = processIdentity(owner.pid);
	return currentIdentity !== undefined && currentIdentity !== owner.identity;
}

/** Cross-process serialization for roster fences and mailbox mutations. */
export function withMailboxMutationLock<T>(
	teamDir: string,
	operation: () => T,
): { acquired: true; value: T } | { acquired: false } {
	const lock = join(teamDir, ".mailbox-mutation.lock");
	const owner: LockOwner = {
		pid: process.pid,
		identity: processIdentity(process.pid) ?? `unknown:${process.pid}`,
		token: randomUUID(),
	};
	const acquire = (): boolean => {
		let created = false;
		try {
			mkdirSync(lock, { mode: 0o700 });
			created = true;
			writeFileSync(join(lock, "owner.json"), JSON.stringify(owner), { mode: 0o600, flag: "wx" });
			return true;
		} catch {
			if (created) {
				try {
					rmSync(lock, { recursive: true });
				} catch {
					// A partial lock remains fail-closed if cleanup is not verifiable.
				}
			}
			return false;
		}
	};
	try {
		mkdirSync(teamDir, { recursive: true, mode: 0o700 });
	} catch {
		return { acquired: false };
	}
	let acquired = acquire();
	if (!acquired) {
		// Serialize stale-owner recovery. Unknown, malformed, or unverifiable owners stay fenced.
		const recovery = join(teamDir, ".mailbox-mutation-recovery.lock");
		try {
			mkdirSync(recovery, { mode: 0o700 });
		} catch {
			return { acquired: false };
		}
		try {
			const existing = readOwner(lock);
			if (!existing || !ownerIsStale(existing) || readOwner(lock)?.token !== existing.token) return { acquired: false };
			rmSync(lock, { recursive: true });
			acquired = acquire();
		} catch {
			return { acquired: false };
		} finally {
			rmdirSync(recovery);
		}
	}
	if (!acquired) return { acquired: false };
	try {
		return { acquired: true, value: operation() };
	} finally {
		try {
			if (readOwner(lock)?.token === owner.token) rmSync(lock, { recursive: true });
		} catch {
			// Preserve the operation result; a leftover lock is recoverable after owner death.
		}
	}
}
