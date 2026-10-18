import type { PeerAdvertisement } from "../domain/peer.js";
export interface PeerRegistry {
	list(projectId: string, signal?: AbortSignal): Promise<PeerAdvertisement[]>;
	publish(ad: PeerAdvertisement): Promise<void>;
	remove(address: PeerAdvertisement): Promise<void>;
}
export function resolvePeerAddress(peers: PeerAdvertisement[], input: string): PeerAdvertisement {
	const exact = peers.filter((peer) => `${peer.peerSessionId}/${peer.runtimeId}` === input);
	const [exactMatch] = exact;
	if (exactMatch) return exactMatch;
	const named = peers.filter((peer) => peer.displayName === input);
	if (named.length !== 1)
		throw new Error(named.length > 1 ? `Peer name is ambiguous: ${input}` : `Peer not found: ${input}`);
	const [namedMatch] = named;
	if (!namedMatch) throw new Error(`Peer not found: ${input}`);
	return namedMatch;
}

export class PeerDiscoveryService {
	constructor(
		private readonly registry: PeerRegistry,
		private readonly now = Date.now,
	) {}
	async discover(projectId: string): Promise<PeerAdvertisement[]> {
		return (await this.registry.list(projectId)).filter(
			(p) => p.protocolVersion === 1 && p.projectId === projectId && this.now() - p.updatedAt < 60_000,
		);
	}
	async publish(ad: PeerAdvertisement): Promise<void> {
		await this.registry.publish({ ...ad, updatedAt: this.now() });
	}
	async unregister(ad: PeerAdvertisement): Promise<void> {
		await this.registry.remove(ad);
	}
}
