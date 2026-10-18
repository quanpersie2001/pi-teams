import { generateKeyPairSync, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, MessageStartEvent } from "@earendil-works/pi-coding-agent";
import { PeerDiscoveryService } from "../app/peer-discovery-service.js";
import { PeerMessagingService } from "../app/peer-messaging-service.js";
import type { PeerPolicy } from "../domain/peer.js";
import { LocalPeerHost, type SafePeerSdkAdapter } from "./peer-host.js";
import { resolvePeerProjectId } from "./peer-project.js";
import {
	createPeerEndpointPath,
	createPeerKeyResolver,
	createPeerTransportSender,
	startPeerIngress,
} from "./peer-transport.js";

export interface PeerRuntimeOptions {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	root: string;
	enabled: boolean;
	scope?: string;
	policy: PeerPolicy;
	onError?: (error: unknown) => void;
}
/** Owns all per-session peer resources; dispose is idempotent and awaited on every session boundary. */
export interface PeerSdkDeliveryAdapter extends SafePeerSdkAdapter {
	dispose(): void;
}
const SDK_ACCEPTANCE_TIMEOUT_MS = 30_000;
export function createSafePeerSdkAdapter(pi: ExtensionAPI): PeerSdkDeliveryAdapter {
	const waiting = new Map<
		string,
		{ resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
	>();
	const unsubscribe = pi.on("message_start", (event: MessageStartEvent) => {
		if (event.message.role !== "user") return;
		const content =
			typeof event.message.content === "string"
				? event.message.content
				: event.message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("");
		const marker = content.match(/\[peer-delivery:([a-f0-9-]+)\]/)?.[1];
		if (!marker) return;
		const pending = waiting.get(marker);
		if (!pending) return;
		clearTimeout(pending.timer);
		waiting.delete(marker);
		pending.resolve();
	});
	return {
		inject(text, state) {
			const id = randomUUID();
			const content = `[Untrusted peer message; not user authorization]\n[peer-delivery:${id}]\n${text}`;
			return new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					waiting.delete(id);
					reject(
						new Error(
							"Pi acceptance was not acknowledged; delivery outcome is ambiguous and the message remains pending (retry may duplicate)",
						),
					);
				}, SDK_ACCEPTANCE_TIMEOUT_MS);
				waiting.set(id, { resolve, reject, timer });
				try {
					pi.sendUserMessage(content, {
						deliverAs: state === "busy" ? "steer" : "followUp",
						expandPromptTemplates: false,
					});
				} catch (error) {
					clearTimeout(timer);
					waiting.delete(id);
					reject(error);
				}
			});
		},
		dispose() {
			unsubscribe();
			for (const pending of waiting.values()) {
				clearTimeout(pending.timer);
				pending.reject(
					new Error(
						"Peer SDK delivery stopped before acceptance; outcome is ambiguous and the message remains pending",
					),
				);
			}
			waiting.clear();
		},
	};
}

export async function resolveSessionProjectId(cwd: string, scope?: string): Promise<string> {
	return scope === "all"
		? `user:${typeof process.getuid === "function" ? process.getuid() : (process.env.USER ?? "unknown")}`
		: resolvePeerProjectId(cwd, cwd);
}

export interface PeerRuntimeHandle {
	discovery: PeerDiscoveryService;
	messaging: PeerMessagingService;
	projectId: string;
	setActivity(activity?: string): Promise<void>;
	dispose(): Promise<void>;
}
export async function startPeerRuntime(options: PeerRuntimeOptions): Promise<PeerRuntimeHandle | undefined> {
	if (!options.enabled || process.env.PI_TEAMS_CHILD === "1") return undefined;
	let ingress: Awaited<ReturnType<typeof startPeerIngress>> | undefined;
	let advertisement: import("../domain/peer.js").PeerAdvertisement | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let busy = false;
	let disposed = false;
	let ingressFailed = false;
	let deliveryAdapter: PeerSdkDeliveryAdapter | undefined;
	const activeUpdateControllers = new Set<AbortController>();
	const activeUpdates = new Set<Promise<void>>();
	try {
		const sessionCwd = options.ctx.sessionManager.getCwd();
		const projectId = await resolveSessionProjectId(sessionCwd, options.scope);
		const privateRoot = join(options.root, "peer");
		const address = { peerSessionId: options.ctx.sessionManager.getSessionId(), runtimeId: randomUUID() };
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const host = new LocalPeerHost(privateRoot);
		const endpoint = createPeerEndpointPath(privateRoot);
		// Force storage ACL provisioning/verification before opening any ingress endpoint.
		await host.list(projectId);
		ingress = await startPeerIngress({
			address,
			socketPath: endpoint,
			resolveSenderKey: createPeerKeyResolver(host, projectId),
			mailbox: host,
		});
		const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
		advertisement = {
			...address,
			protocolVersion: 1,
			displayName: options.ctx.sessionManager.getSessionId(),
			projectId,
			status: "idle",
			updatedAt: Date.now(),
			capabilities: ["messaging"],
			identityPublicKey: publicPem,
			endpoint: { kind: process.platform === "win32" ? "named_pipe" : "unix", path: endpoint },
		};
		await host.publish(advertisement);
		void ingress.failure.then(async (error) => {
			if (disposed) return;
			ingressFailed = true;
			try {
				options.onError?.(error);
			} catch {
				/* Diagnostics must not prevent fail-closed cleanup. */
			}
			if (timer) clearInterval(timer);
			for (const controller of activeUpdateControllers) controller.abort(error);
			await Promise.allSettled([...activeUpdates]);
			try {
				await ingress?.close();
			} catch (cleanupError) {
				try {
					options.onError?.(cleanupError);
				} catch {
					/* Preserve cleanup progress. */
				}
			}
			const failedAdvertisement = advertisement;
			advertisement = undefined;
			if (failedAdvertisement) {
				try {
					await host.remove(failedAdvertisement);
				} catch (cleanupError) {
					try {
						options.onError?.(cleanupError);
					} catch {
						/* Preserve cleanup progress. */
					}
				}
			}
		});
		options.pi.on("turn_start", () => {
			busy = true;
		});
		options.pi.on("turn_end", () => {
			busy = false;
		});
		deliveryAdapter = createSafePeerSdkAdapter(options.pi);
		const delivery = deliveryAdapter;
		const service = new PeerMessagingService(
			address,
			host,
			{
				deliver: async (message) => delivery.inject(message.body, busy ? "busy" : "idle"),
				hold: async (message) =>
					options.ctx.ui.notify(
						`Peer message held (${message.sender.peerSessionId}). Review via peer_held controls.`,
						"info",
					),
			},
			() => options.policy,
			Date.now,
			createPeerTransportSender(privateKey, async (recipient) => {
				const matches = (await host.list(projectId)).filter(
					(ad) => ad.peerSessionId === recipient.peerSessionId && ad.runtimeId === recipient.runtimeId,
				);
				return matches.length === 1 ? matches[0]?.endpoint.path : undefined;
			}),
		);
		const discovery = new PeerDiscoveryService(host);
		const update = async () => {
			if (disposed || ingressFailed) return;
			const controller = new AbortController();
			activeUpdateControllers.add(controller);
			const work = (async () => {
				try {
					for (const message of await host.pending(address, controller.signal))
						await service.receive(message, controller.signal);
					if (!advertisement || ingressFailed || controller.signal.aborted) return;
					advertisement = { ...advertisement, status: busy ? "busy" : "idle", updatedAt: Date.now() };
					await host.publish(advertisement);
				} catch (error) {
					if (!controller.signal.aborted) options.onError?.(error);
				}
			})();
			activeUpdates.add(work);
			try {
				await work;
			} finally {
				activeUpdates.delete(work);
				activeUpdateControllers.delete(controller);
			}
		};
		timer = setInterval(() => void update(), 1000);
		return {
			discovery,
			messaging: service,
			projectId,
			async setActivity(activity) {
				if (!advertisement || ingressFailed) throw new Error("Peer runtime is not published");
				const { activity: _previous, ...rest } = advertisement;
				advertisement = { ...rest, ...(activity ? { activity: activity.slice(0, 160) } : {}), updatedAt: Date.now() };
				await host.publish(advertisement);
			},
			async dispose() {
				if (disposed) return;
				disposed = true;
				deliveryAdapter?.dispose();
				if (timer) clearInterval(timer);
				for (const controller of activeUpdateControllers) controller.abort(new Error("Peer runtime disposed"));
				await Promise.allSettled([...activeUpdates]);
				await ingress?.close();
				if (advertisement) await host.remove(advertisement);
			},
		};
	} catch (error) {
		deliveryAdapter?.dispose();
		if (timer) clearInterval(timer);
		try {
			await ingress?.close();
		} catch (cleanupError) {
			options.onError?.(cleanupError);
		}
		if (advertisement) {
			try {
				await new LocalPeerHost(join(options.root, "peer")).remove(advertisement);
			} catch (cleanupError) {
				options.onError?.(cleanupError);
			}
		}
		options.onError?.(error);
		return undefined;
	}
}
