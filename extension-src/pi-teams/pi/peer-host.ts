import { createPublicKey, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PeerRegistry } from "../app/peer-discovery-service.js";
import type { PeerMailbox, PeerMessageBinding } from "../app/peer-messaging-service.js";
import type { PeerAddress, PeerReceipt } from "../domain/peer.js";
import { type PeerAdvertisement, validatePeerAdvertisement } from "../domain/peer.js";
import { PEER_LIMITS, type PeerMessage, peerMessageFingerprint, validatePeerMessage } from "../domain/peer-message.js";
import { ensureWindowsPeerStorage } from "./windows-peer-acl.js";

const TERMINAL = new Set<PeerReceipt>(["delivered", "refused", "expired"]);
const CLAIM_STALE_MS = 5 * 60_000;

type DirectoryIdentity = { dev: number; ino: number };
type SharedVerification<T> = {
	controller: AbortController;
	promise: Promise<T>;
	waiters: number;
	settled: boolean;
};
function createSharedVerification<T>(verify: (signal: AbortSignal) => Promise<T>): SharedVerification<T> {
	const controller = new AbortController();
	const entry = { controller, promise: undefined as unknown as Promise<T>, waiters: 0, settled: false };
	entry.promise = Promise.resolve()
		.then(() => verify(controller.signal))
		.finally(() => {
			entry.settled = true;
		});
	return entry;
}
function waitForSharedVerification<T>(entry: SharedVerification<T>, signal?: AbortSignal): Promise<T> {
	throwIfAborted(signal);
	entry.waiters++;
	return new Promise<T>((resolve, reject) => {
		let finished = false;
		const cleanup = () => {
			if (signal) signal.removeEventListener("abort", onAbort);
			entry.waiters--;
		};
		const onAbort = () => {
			if (finished) return;
			finished = true;
			cleanup();
			const reason = signal?.reason ?? new Error("Peer storage verification aborted");
			if (entry.waiters === 0 && !entry.settled) {
				entry.controller.abort(reason);
				entry.promise.then(
					() => reject(reason),
					() => reject(reason),
				);
			} else reject(reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		entry.promise.then(
			(value) => {
				if (finished) return;
				finished = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (finished) return;
				finished = true;
				cleanup();
				reject(error);
			},
		);
		if (signal?.aborted) onAbort();
	});
}
function sameDirectoryIdentity(statResult: Awaited<ReturnType<typeof lstat>>, identity: DirectoryIdentity): boolean {
	return statResult.dev === identity.dev && statResult.ino !== 0 && statResult.ino === identity.ino;
}
// The PowerShell verifier performs the authoritative full reparse-attribute walk. This per-use check
// protects cached identities against ordinary path replacement; malicious same-user ACL races are out of scope.
async function assertNoWindowsReparseAncestors(path: string): Promise<void> {
	let current = resolve(path);
	for (;;) {
		const item = await lstat(current);
		if (item.isSymbolicLink() || !item.isDirectory())
			throw new Error("Peer storage path must not traverse a reparse point");
		const parent = dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

/** Per-user durable registry/inbox; Windows storage is provisioned and audited through the OS ACL adapter. */
export class LocalPeerHost implements PeerRegistry, PeerMailbox {
	private lastPruneAt = 0;
	private windowsRootIdentity: DirectoryIdentity | undefined;
	private windowsRootInitialization: SharedVerification<void> | undefined;
	private readonly windowsDirectoryIdentities = new Map<string, DirectoryIdentity>();
	private readonly windowsDirectoryChecks = new Map<string, SharedVerification<DirectoryIdentity>>();
	constructor(private root: string) {}
	protected async linkInboxEntry(temp: string, target: string): Promise<void> {
		await link(temp, target);
	}
	private async ensureWindowsRoot(signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		if (this.windowsRootIdentity) {
			let current: Awaited<ReturnType<typeof lstat>> | undefined;
			try {
				await assertNoWindowsReparseAncestors(this.root);
				current = await lstat(this.root);
			} catch {
				// Re-run the OS verifier below; never trust stale identity evidence.
			}
			if (
				current?.isDirectory() &&
				!current.isSymbolicLink() &&
				sameDirectoryIdentity(current, this.windowsRootIdentity)
			) {
				throwIfAborted(signal);
				return;
			}
			this.windowsRootIdentity = undefined;
			this.windowsDirectoryIdentities.clear();
		}
		let check = this.windowsRootInitialization;
		if (!check) {
			check = createSharedVerification(async (verificationSignal) => {
				if (!(await ensureWindowsPeerStorage(this.root, verificationSignal)))
					throw new Error("Windows peer storage root ACL validation/provisioning failed");
				throwIfAborted(verificationSignal);
				const canonicalRoot = await realpath(this.root);
				await assertNoWindowsReparseAncestors(canonicalRoot);
				const rootStat = await lstat(canonicalRoot);
				if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
					throw new Error("Peer storage root must be a directory, not a reparse point");
				this.root = canonicalRoot;
				if (rootStat.ino !== 0) this.windowsRootIdentity = { dev: rootStat.dev, ino: rootStat.ino };
			});
			this.windowsRootInitialization = check;
		}
		try {
			await waitForSharedVerification(check, signal);
		} finally {
			if (check.settled && this.windowsRootInitialization === check) this.windowsRootInitialization = undefined;
		}
	}
	private async ensureWindowsDirectory(dir: string, signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		const cached = this.windowsDirectoryIdentities.get(dir);
		if (cached) {
			let current: Awaited<ReturnType<typeof lstat>> | undefined;
			try {
				await assertNoWindowsReparseAncestors(dir);
				current = await lstat(dir);
			} catch {
				// A missing/replaced path loses its cached proof and must be revalidated by PowerShell.
			}
			if (current?.isDirectory() && !current.isSymbolicLink() && sameDirectoryIdentity(current, cached)) {
				throwIfAborted(signal);
				return;
			}
			this.windowsDirectoryIdentities.delete(dir);
		}
		let check = this.windowsDirectoryChecks.get(dir);
		if (!check) {
			check = createSharedVerification(async (verificationSignal) => {
				if (!(await ensureWindowsPeerStorage(dir, verificationSignal)))
					throw new Error("Windows peer storage directory ACL validation/provisioning failed");
				throwIfAborted(verificationSignal);
				await assertNoWindowsReparseAncestors(dir);
				const current = await lstat(dir);
				if (!current.isDirectory() || current.isSymbolicLink())
					throw new Error("Peer storage directory must be a directory, not a reparse point");
				const identity = { dev: current.dev, ino: current.ino };
				if (identity.ino !== 0) this.windowsDirectoryIdentities.set(dir, identity);
				return identity;
			});
			this.windowsDirectoryChecks.set(dir, check);
		}
		try {
			await waitForSharedVerification(check, signal);
		} finally {
			if (check.settled && this.windowsDirectoryChecks.get(dir) === check) this.windowsDirectoryChecks.delete(dir);
		}
	}
	private async ready(dir: string, signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		if (process.platform === "win32") {
			const requestedRoot = resolve(this.root);
			const relativeDir = relative(requestedRoot, resolve(dir));
			if (!relativeDir || relativeDir === ".." || relativeDir.startsWith(`..\\`) || isAbsolute(relativeDir))
				throw new Error("Peer storage directory must be beneath its root");
			await this.ensureWindowsRoot(signal);
			dir = resolve(this.root, relativeDir);
			await this.ensureWindowsDirectory(dir, signal);
		} else await mkdir(this.root, { recursive: true, mode: 0o700 });
		const canonicalRoot = await realpath(this.root),
			requestedRoot = resolve(this.root);
		const macAlias =
			process.platform === "darwin" && canonicalRoot === requestedRoot.replace(/^\/(var|tmp)(?=\/)/, "/private/$1");
		if (process.platform !== "win32" && canonicalRoot !== requestedRoot && !macAlias)
			throw new Error("Peer storage root must not traverse symlink ancestors");
		this.root = canonicalRoot;
		const rootStat = await lstat(this.root);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
			throw new Error("Peer storage root must be a directory, not a symlink");
		if (
			process.platform !== "win32" &&
			((typeof process.getuid === "function" && rootStat.uid !== process.getuid()) || (rootStat.mode & 0o077) !== 0)
		)
			throw new Error("Peer storage root must be current-user-owned and private (mode 0700)");
		if (process.platform !== "win32") await mkdir(dir, { recursive: true, mode: 0o700 });
		const s = await lstat(dir);
		if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Peer storage directory must not be a symlink");
		if (
			process.platform !== "win32" &&
			((typeof process.getuid === "function" && s.uid !== process.getuid()) || (s.mode & 0o077) !== 0)
		)
			throw new Error("Peer storage directory must be current-user-owned and private");
		throwIfAborted(signal);
	}
	async publish(ad: PeerAdvertisement): Promise<void> {
		if (!validatePeerAdvertisement(ad)) throw new Error("Invalid peer advertisement");
		try {
			if (createPublicKey(ad.identityPublicKey).asymmetricKeyType !== "ed25519") throw new Error();
		} catch {
			throw new Error("Peer advertisement must contain a valid Ed25519 SPKI public key");
		}
		if (process.platform === "win32" ? ad.endpoint.kind !== "named_pipe" : ad.endpoint.kind !== "unix")
			throw new Error("Peer advertisement endpoint kind does not match this host platform");
		const dir = join(this.root, "registry");
		await this.ready(dir);
		const file = join(dir, `${safe(ad.peerSessionId)}-${safe(ad.runtimeId)}.json`),
			temp = `${file}.${randomUUID()}.tmp`;
		await writeFile(temp, JSON.stringify(ad), { mode: 0o600, flag: "wx" });
		await rename(temp, file);
	}
	async list(projectId: string, signal?: AbortSignal): Promise<PeerAdvertisement[]> {
		throwIfAborted(signal);
		const dir = join(this.root, "registry");
		await this.ready(dir, signal);
		throwIfAborted(signal);
		const out: PeerAdvertisement[] = [];
		for (const f of await readdir(dir)) {
			throwIfAborted(signal);
			if (!f.endsWith(".json")) continue;
			try {
				const v: unknown = JSON.parse(await readFile(join(dir, f), "utf8"));
				if (validatePeerAdvertisement(v) && v.projectId === projectId) out.push(v);
			} catch {
				throwIfAborted(signal);
				/* Corrupt registration is invisible. */
			}
		}
		return out;
	}
	async remove(ad: PeerAdvertisement): Promise<void> {
		await rm(join(this.root, "registry", `${safe(ad.peerSessionId)}-${safe(ad.runtimeId)}.json`), { force: true });
	}
	private async bind(message: PeerMessage, signal?: AbortSignal): Promise<"new" | "duplicate" | "conflict"> {
		const dir = join(this.root, "bindings");
		await this.ready(dir, signal);
		const record = {
			sender: message.sender,
			fingerprint: peerMessageFingerprint(message),
			expiresAt: message.expiresAt,
			updatedAt: Date.now(),
		};
		const file = join(dir, `${safe(message.messageId)}.json`),
			temp = `${file}.${randomUUID()}.tmp`;
		try {
			throwIfAborted(signal);
			await writeFile(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
			throwIfAborted(signal);
			await link(temp, file);
			return "new";
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			const existing = await this.getBinding(message.messageId);
			return existing?.fingerprint === record.fingerprint &&
				existing.sender.peerSessionId === record.sender.peerSessionId &&
				existing.sender.runtimeId === record.sender.runtimeId
				? "duplicate"
				: "conflict";
		} finally {
			await rm(temp, { force: true });
		}
	}
	async acceptIngress(
		message: PeerMessage,
		signal?: AbortSignal,
	): Promise<{
		status: "queued" | "held" | "delivered" | "refused" | "expired" | "unavailable" | "conflict" | "rate_limited";
	}> {
		throwIfAborted(signal);
		const now = Date.now();
		if (now - this.lastPruneAt > 60_000) {
			this.lastPruneAt = now;
			await this.prune(now, signal);
		}
		return this.withQuotaLock(async () => {
			throwIfAborted(signal);
			const fingerprint = peerMessageFingerprint(message),
				prior = await this.getBinding(message.messageId);
			throwIfAborted(signal);
			if (
				prior &&
				(prior.fingerprint !== fingerprint ||
					prior.sender.peerSessionId !== message.sender.peerSessionId ||
					prior.sender.runtimeId !== message.sender.runtimeId)
			)
				return { status: "conflict" };
			const terminal = await this.receiptState(message.messageId);
			throwIfAborted(signal);
			if (terminal === "delivered" || terminal === "refused" || terminal === "expired") {
				if (!prior && (await this.terminalFingerprint(message.messageId)) !== fingerprint)
					return { status: "conflict" };
				return { status: terminal };
			}
			if (terminal === "held") return { status: "held" };
			if (!prior && terminal) return { status: "conflict" };
			throwIfAborted(signal);
			const rateDir = join(this.root, "rates");
			await this.ready(rateDir, signal);
			throwIfAborted(signal);
			const rateFile = join(rateDir, `${safe(message.sender.peerSessionId)}-${safe(message.sender.runtimeId)}.json`);
			if (
				!(await exists(rateFile)) &&
				(await safeReadDir(rateDir)).filter((f) => f.endsWith(".json")).length >= PEER_LIMITS.metadataRecords
			)
				return { status: "unavailable" };
			let times: number[] = [];
			try {
				const v = JSON.parse(await readFile(rateFile, "utf8")) as { times?: unknown };
				if (Array.isArray(v.times))
					times = v.times.filter(
						(n): n is number => typeof n === "number" && Date.now() - n < PEER_LIMITS.rateWindowMs,
					);
			} catch {}
			throwIfAborted(signal);
			if (times.length >= PEER_LIMITS.rateCount) return { status: "rate_limited" };
			times.push(Date.now());
			const rateTemp = `${rateFile}.${randomUUID()}.tmp`;
			try {
				throwIfAborted(signal);
				await writeFile(rateTemp, JSON.stringify({ times }), { flag: "wx", mode: 0o600 });
				throwIfAborted(signal);
				await rename(rateTemp, rateFile);
			} finally {
				await rm(rateTemp, { force: true });
			}
			throwIfAborted(signal);
			const bindingsDir = join(this.root, "bindings");
			if (
				!prior &&
				(await safeReadDir(bindingsDir)).filter((f) => f.endsWith(".json")).length >= PEER_LIMITS.metadataRecords
			)
				return { status: "unavailable" };
			const dir = join(this.root, "inbox", safe(message.recipient.peerSessionId), safe(message.recipient.runtimeId));
			await this.ready(dir, signal);
			throwIfAborted(signal);
			const target = join(dir, `${safe(message.messageId)}.json`);
			if (!(await exists(target)) && (await this.pendingCount(message.recipient, signal)) >= PEER_LIMITS.pending)
				return { status: "unavailable" };
			if (!prior && (await this.bind(message, signal)) === "conflict") return { status: "conflict" };
			throwIfAborted(signal);
			let committedByThisRequest = false;
			if (!(await exists(target))) {
				const temp = `${target}.${randomUUID()}.tmp`;
				throwIfAborted(signal);
				try {
					await writeFile(temp, JSON.stringify(message), { flag: "wx", mode: 0o600 });
					throwIfAborted(signal);
					await this.linkInboxEntry(temp, target);
					committedByThisRequest = true;
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
				} finally {
					await rm(temp, { force: true }).catch(() => {});
				}
			}
			if (!committedByThisRequest) throwIfAborted(signal);
			// The successful hard link is the commit point; persist its receipt even if shutdown races afterward.
			return {
				status: await this.setReceiptUnlocked(
					message.messageId,
					"queued",
					fingerprint,
					committedByThisRequest ? undefined : signal,
				),
			};
		}, signal);
	}
	async getBinding(messageId: string): Promise<PeerMessageBinding | undefined> {
		const record = await this.readBindingRecord(messageId);
		return record ? { sender: record.sender, fingerprint: record.fingerprint } : undefined;
	}
	private async readBindingRecord(
		messageId: string,
	): Promise<{ sender: PeerAddress; fingerprint: string; expiresAt: number } | undefined> {
		try {
			const v: unknown = JSON.parse(await readFile(join(this.root, "bindings", `${safe(messageId)}.json`), "utf8"));
			if (!v || typeof v !== "object") return undefined;
			const x = v as { sender?: Partial<PeerAddress>; fingerprint?: unknown; expiresAt?: unknown };
			if (
				typeof x.fingerprint !== "string" ||
				typeof x.sender?.peerSessionId !== "string" ||
				typeof x.sender.runtimeId !== "string" ||
				typeof x.expiresAt !== "number"
			)
				return undefined;
			return {
				sender: { peerSessionId: x.sender.peerSessionId, runtimeId: x.sender.runtimeId },
				fingerprint: x.fingerprint,
				expiresAt: x.expiresAt,
			};
		} catch {
			return undefined;
		}
	}
	async claim(messageId: string, signal?: AbortSignal): Promise<(() => Promise<void>) | undefined> {
		throwIfAborted(signal);
		const dir = join(this.root, "claims");
		await this.ready(dir, signal);
		throwIfAborted(signal);
		const file = join(dir, `${safe(messageId)}.lock`);
		for (let attempt = 0; attempt < 2; attempt++) {
			throwIfAborted(signal);
			let token = "";
			let acquired = false;
			try {
				token = randomUUID();
				const handle = await open(file, "wx", 0o600);
				acquired = true;
				try {
					await handle.writeFile(JSON.stringify({ token, pid: process.pid, at: Date.now() }));
				} finally {
					await handle.close();
				}
				throwIfAborted(signal);
				return async () => this.releaseClaim(file, token);
			} catch (error) {
				if (acquired) {
					await this.releaseClaim(file, token);
					throw error;
				}
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try {
					const info = await stat(file);
					if (Date.now() - info.mtimeMs > CLAIM_STALE_MS) {
						let pid: number | undefined;
						try {
							const value = JSON.parse(await readFile(file, "utf8")) as { pid?: unknown };
							if (typeof value.pid === "number") pid = value.pid;
						} catch {}
						throwIfAborted(signal);
						if (pid === undefined || !pidIsAlive(pid)) {
							await rm(file, { force: true });
							continue;
						}
					}
				} catch {
					throwIfAborted(signal);
					continue;
				}
				return undefined;
			}
		}
		return undefined;
	}
	private async releaseClaim(file: string, token: string): Promise<void> {
		try {
			const current = JSON.parse(await readFile(file, "utf8")) as { token?: unknown };
			if (current.token === token) await rm(file, { force: true });
		} catch {}
	}
	async receiptState(messageId: string): Promise<PeerReceipt | undefined> {
		const dir = join(this.root, "receipts"),
			id = safe(messageId);
		try {
			const v = JSON.parse(await readFile(join(dir, `${id}.terminal.json`), "utf8")) as { receipt?: unknown };
			if (v.receipt === "delivered" || v.receipt === "refused" || v.receipt === "expired") return v.receipt;
		} catch {}
		for (const r of ["held", "queued"] as const) if (await exists(join(dir, `${id}.${r}.json`))) return r;
		return undefined;
	}
	private async terminalFingerprint(messageId: string): Promise<string | undefined> {
		try {
			const record = JSON.parse(
				await readFile(join(this.root, "receipts", `${safe(messageId)}.terminal.json`), "utf8"),
			) as { fingerprint?: unknown };
			return typeof record.fingerprint === "string" ? record.fingerprint : undefined;
		} catch {
			return undefined;
		}
	}
	async setReceipt(
		messageId: string,
		receipt: PeerReceipt,
		fingerprint?: string,
		signal?: AbortSignal,
	): Promise<PeerReceipt> {
		return this.withQuotaLock(() => this.setReceiptUnlocked(messageId, receipt, fingerprint, signal), signal);
	}
	private async setReceiptUnlocked(
		messageId: string,
		receipt: PeerReceipt,
		fingerprint?: string,
		signal?: AbortSignal,
	): Promise<PeerReceipt> {
		throwIfAborted(signal);
		const dir = join(this.root, "receipts");
		await this.ready(dir, signal);
		throwIfAborted(signal);
		const id = safe(messageId);
		if (receipt === "unavailable") return (await this.receiptState(id)) ?? "unavailable";
		const current = await this.receiptState(id);
		if (
			!(await exists(join(dir, `${id}.queued.json`))) &&
			!(await exists(join(dir, `${id}.held.json`))) &&
			!(await exists(join(dir, `${id}.terminal.json`))) &&
			(await safeReadDir(dir)).filter((f) => f.endsWith(".json")).length >= PEER_LIMITS.metadataRecords
		)
			throw new Error("Peer receipt retention capacity reached; prune before accepting more messages");
		if (current && (TERMINAL.has(current) || receipt === "queued" || (current === "held" && receipt === "held")))
			return current;
		if (fingerprint) {
			const binding = await this.getBinding(id);
			if (binding && binding.fingerprint !== fingerprint)
				throw new Error("Receipt fingerprint conflicts with immutable message binding");
		}
		const terminal = TERMINAL.has(receipt),
			file = join(dir, `${id}.${terminal ? "terminal" : receipt}.json`);
		try {
			const binding = await this.readBindingRecord(id);
			throwIfAborted(signal);
			await writeFile(
				file,
				JSON.stringify({ receipt, fingerprint, expiresAt: binding?.expiresAt, updatedAt: Date.now() }),
				{
					flag: "wx",
					mode: 0o600,
				},
			);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		throwIfAborted(signal);
		return (await this.receiptState(id)) ?? receipt;
	}
	async holdMessage(message: PeerMessage, signal?: AbortSignal): Promise<boolean> {
		return this.withQuotaLock(async () => {
			throwIfAborted(signal);
			const target = join(this.root, "held", `${safe(message.messageId)}.json`);
			await this.ready(dirname(target), signal);
			throwIfAborted(signal);
			const inboxFile = join(
				this.root,
				"inbox",
				safe(message.recipient.peerSessionId),
				safe(message.recipient.runtimeId),
				`${safe(message.messageId)}.json`,
			);
			if (
				!(await exists(target)) &&
				!(await exists(inboxFile)) &&
				(await this.pendingCount(message.recipient)) >= PEER_LIMITS.pending
			)
				return false;
			const temp = `${target}.${randomUUID()}.tmp`;
			throwIfAborted(signal);
			try {
				await writeFile(temp, JSON.stringify(message), { flag: "wx", mode: 0o600 });
				throwIfAborted(signal);
				await link(temp, target);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			} finally {
				await rm(temp, { force: true });
			}
			throwIfAborted(signal);
			await this.removeFromInbox(message.messageId, message.recipient, signal);
			return true;
		}, signal);
	}
	private async pendingCount(recipient: PeerAddress, signal?: AbortSignal): Promise<number> {
		let count = 0;
		const inbox = join(this.root, "inbox", safe(recipient.peerSessionId), safe(recipient.runtimeId));
		for (const file of await safeReadDir(inbox)) {
			throwIfAborted(signal);
			if (!file.endsWith(".json")) continue;
			const path = join(inbox, file);
			try {
				const m: unknown = JSON.parse(await readFile(path, "utf8"));
				if (validatePeerMessage(m) && m.expiresAt > Date.now()) count++;
				else {
					if (validatePeerMessage(m))
						await this.setReceiptUnlocked(m.messageId, "expired", peerMessageFingerprint(m), signal);
					throwIfAborted(signal);
					await rm(path, { force: true });
				}
			} catch {
				throwIfAborted(signal);
				await rm(path, { force: true });
			}
		}
		const held = join(this.root, "held");
		try {
			for (const f of await readdir(held)) {
				throwIfAborted(signal);
				if (!f.endsWith(".json")) continue;
				try {
					const m: unknown = JSON.parse(await readFile(join(held, f), "utf8"));
					if (
						validatePeerMessage(m) &&
						m.recipient.peerSessionId === recipient.peerSessionId &&
						m.recipient.runtimeId === recipient.runtimeId
					) {
						if (m.expiresAt > Date.now()) count++;
						else {
							await this.setReceiptUnlocked(m.messageId, "expired", peerMessageFingerprint(m), signal);
							throwIfAborted(signal);
							await rm(join(held, f), { force: true });
						}
					}
				} catch {
					throwIfAborted(signal);
				}
			}
		} catch {
			throwIfAborted(signal);
		}
		return count;
	}
	private async withQuotaLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		throwIfAborted(signal);
		const dir = join(this.root, "locks");
		await this.ready(dir, signal);
		throwIfAborted(signal);
		const lock = join(dir, "quota.lock");
		let token = "";
		let acquired = false;
		for (;;) {
			throwIfAborted(signal);
			try {
				token = randomUUID();
				const h = await open(lock, "wx", 0o600);
				acquired = true;
				try {
					await h.writeFile(JSON.stringify({ token, pid: process.pid }));
				} finally {
					await h.close();
				}
				throwIfAborted(signal);
				break;
			} catch (error) {
				if (acquired) {
					await this.releaseQuotaLock(lock, token);
					throw error;
				}
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try {
					const s = await stat(lock);
					if (Date.now() - s.mtimeMs > 30_000) {
						let pid: number | undefined;
						try {
							const value = JSON.parse(await readFile(lock, "utf8")) as { pid?: unknown };
							if (typeof value.pid === "number") pid = value.pid;
						} catch {}
						throwIfAborted(signal);
						if (pid === undefined || !pidIsAlive(pid)) await rm(lock, { force: true });
					}
				} catch {
					throwIfAborted(signal);
				}
				await abortableDelay(5, signal);
			}
		}
		try {
			throwIfAborted(signal);
			return await fn();
		} finally {
			await this.releaseQuotaLock(lock, token);
		}
	}
	private async releaseQuotaLock(lock: string, token: string): Promise<void> {
		try {
			const current = JSON.parse(await readFile(lock, "utf8")) as { token?: unknown };
			if (current.token === token) await rm(lock, { force: true });
		} catch {}
	}
	async removeFromInbox(messageId: string, recipient: PeerAddress, signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		await rm(
			join(this.root, "inbox", safe(recipient.peerSessionId), safe(recipient.runtimeId), `${safe(messageId)}.json`),
			{ force: true },
		);
	}
	async pending(address: PeerAddress, signal?: AbortSignal): Promise<PeerMessage[]> {
		throwIfAborted(signal);
		const dir = join(this.root, "inbox", safe(address.peerSessionId), safe(address.runtimeId));
		await this.ready(dir, signal);
		throwIfAborted(signal);
		const out: PeerMessage[] = [];
		for (const f of await readdir(dir)) {
			throwIfAborted(signal);
			if (!f.endsWith(".json")) continue;
			try {
				const v: unknown = JSON.parse(await readFile(join(dir, f), "utf8"));
				if (validatePeerMessage(v) && v.expiresAt > Date.now()) out.push(v);
				else {
					if (validatePeerMessage(v)) await this.setReceipt(v.messageId, "expired", peerMessageFingerprint(v), signal);
					throwIfAborted(signal);
					await rm(join(dir, f), { force: true });
				}
			} catch {
				throwIfAborted(signal);
				await rm(join(dir, f), { force: true });
			}
		}
		return out;
	}
	async getHeld(messageId: string): Promise<PeerMessage | undefined> {
		try {
			const v: unknown = JSON.parse(await readFile(join(this.root, "held", `${safe(messageId)}.json`), "utf8"));
			return validatePeerMessage(v) ? v : undefined;
		} catch {
			return undefined;
		}
	}
	async listHeld(signal?: AbortSignal): Promise<PeerMessage[]> {
		throwIfAborted(signal);
		const dir = join(this.root, "held");
		await this.ready(dir, signal);
		throwIfAborted(signal);
		const out: PeerMessage[] = [];
		for (const f of await readdir(dir)) {
			throwIfAborted(signal);
			if (!f.endsWith(".json")) continue;
			const id = f.slice(0, -5),
				m = await this.getHeld(id);
			if (!m) {
				throwIfAborted(signal);
				await rm(join(dir, f), { force: true });
				continue;
			}
			if (m.expiresAt <= Date.now()) {
				await this.setReceipt(id, "expired", peerMessageFingerprint(m), signal);
				await this.removeHeld(id, signal);
				await this.removeFromInbox(id, m.recipient, signal);
				continue;
			}
			out.push(m);
		}
		return out;
	}
	async removeHeld(messageId: string, signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		await rm(join(this.root, "held", `${safe(messageId)}.json`), { force: true });
	}
	private async pruneClaims(now: number, signal?: AbortSignal): Promise<void> {
		const dir = join(this.root, "claims");
		for (const file of await safeReadDir(dir)) {
			throwIfAborted(signal);
			if (!file.endsWith(".lock")) continue;
			const path = join(dir, file);
			try {
				const info = await stat(path);
				if (now - info.mtimeMs <= CLAIM_STALE_MS) continue;
				let pid: number | undefined;
				try {
					const value = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
					if (typeof value.pid === "number") pid = value.pid;
				} catch {}
				throwIfAborted(signal);
				if (pid === undefined || !pidIsAlive(pid)) await rm(path, { force: true });
			} catch {
				throwIfAborted(signal);
			}
		}
	}
	async prune(now = Date.now(), signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		await this.listHeld(signal);
		for (const sub of await safeReadDir(join(this.root, "inbox"))) {
			throwIfAborted(signal);
			for (const runtime of await safeReadDir(join(this.root, "inbox", sub))) {
				const dir = join(this.root, "inbox", sub, runtime);
				for (const f of await safeReadDir(dir)) {
					throwIfAborted(signal);
					try {
						const m: unknown = JSON.parse(await readFile(join(dir, f), "utf8"));
						if (validatePeerMessage(m) && m.expiresAt <= now) {
							await this.setReceipt(m.messageId, "expired", peerMessageFingerprint(m), signal);
							throwIfAborted(signal);
							await rm(join(dir, f), { force: true });
						}
					} catch {
						throwIfAborted(signal);
						await rm(join(dir, f), { force: true });
					}
				}
			}
		}
		await this.pruneClaims(now, signal);
		for (const category of ["bindings", "receipts", "rates", "authenticated", "seen"] as const) {
			throwIfAborted(signal);
			const dir = join(this.root, category);
			for (const f of await safeReadDir(dir)) {
				throwIfAborted(signal);
				try {
					const path = join(dir, f),
						s = await stat(path);
					if (category === "bindings" || (category === "receipts" && f.endsWith(".terminal.json"))) {
						const record = JSON.parse(await readFile(path, "utf8")) as { expiresAt?: unknown };
						if (typeof record.expiresAt === "number") {
							if (now > record.expiresAt + PEER_LIMITS.retentionMs) {
								throwIfAborted(signal);
								await rm(path, { force: true });
							}
						} else if (now - s.mtimeMs > PEER_LIMITS.retentionMs) {
							throwIfAborted(signal);
							await rm(path, { force: true });
						}
					} else if (now - s.mtimeMs > PEER_LIMITS.retentionMs) {
						throwIfAborted(signal);
						await rm(path, { force: true });
					}
				} catch {
					throwIfAborted(signal);
					try {
						const path = join(dir, f);
						if (now - (await stat(path)).mtimeMs > PEER_LIMITS.retentionMs) await rm(path, { force: true });
					} catch {
						throwIfAborted(signal);
					}
				}
			}
		}
	}
}
function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	const error = new Error("Peer ingress operation aborted");
	error.name = "AbortError";
	throw error;
}
function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
	return new Promise((resolve, reject) => {
		const cleanup = () => signal.removeEventListener("abort", abort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, milliseconds);
		const abort = () => {
			clearTimeout(timer);
			cleanup();
			try {
				throwIfAborted(signal);
			} catch (error) {
				reject(error);
			}
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}
function safe(value: string): string {
	if (!/^[\w.-]{1,128}$/.test(value)) throw new Error("Invalid peer identifier");
	return value;
}
function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}
async function safeReadDir(path: string): Promise<string[]> {
	try {
		return await readdir(path);
	} catch {
		return [];
	}
}
/** Host must serialize injections through Pi's turn queue and set expandPromptTemplates:false. */
export interface SafePeerSdkAdapter {
	inject(text: string, state: "idle" | "busy"): Promise<void>;
}
