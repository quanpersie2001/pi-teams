/** Independent Pi session address; runtimeId prevents delivery across session incarnations. */
export interface PeerAddress {
	peerSessionId: string;
	runtimeId: string;
}
export interface PeerAdvertisement extends PeerAddress {
	protocolVersion: 1;
	displayName: string;
	projectId: string;
	status: "idle" | "busy" | "unavailable";
	activity?: string;
	updatedAt: number;
	capabilities: string[];
	identityPublicKey: string;
	endpoint: { kind: "unix" | "named_pipe"; path: string };
}
export type PeerPolicy = "accept" | "hold" | "refuse";
export type PeerReceipt = "queued" | "held" | "delivered" | "refused" | "unavailable" | "expired";

export function validatePeerAdvertisement(value: unknown): value is PeerAdvertisement {
	if (!value || typeof value !== "object") return false;
	const ad = value as Partial<PeerAdvertisement>;
	return (
		ad.protocolVersion === 1 &&
		bounded(ad.peerSessionId, 128) &&
		bounded(ad.runtimeId, 128) &&
		bounded(ad.displayName, 128) &&
		bounded(ad.projectId, 1024) &&
		(ad.status === "idle" || ad.status === "busy" || ad.status === "unavailable") &&
		(ad.activity === undefined || bounded(ad.activity, 160)) &&
		typeof ad.updatedAt === "number" &&
		Number.isFinite(ad.updatedAt) &&
		Array.isArray(ad.capabilities) &&
		ad.capabilities.length <= 32 &&
		ad.capabilities.every((c) => bounded(c, 64)) &&
		bounded(ad.identityPublicKey, 4096) &&
		isPeerEndpoint(ad.endpoint)
	);
}
function isPeerEndpoint(value: unknown): value is PeerAdvertisement["endpoint"] {
	if (!value || typeof value !== "object") return false;
	const endpoint = value as { kind?: unknown; path?: unknown };
	if (!bounded(endpoint.path, 1024)) return false;
	if (endpoint.kind === "unix") return endpoint.path.startsWith("/") && !endpoint.path.includes("\\0");
	if (endpoint.kind === "named_pipe") {
		const prefix = "\\\\.\\pipe\\pi-teams-peer-";
		return (
			endpoint.path.startsWith(prefix) &&
			/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(endpoint.path.slice(prefix.length))
		);
	}
	return false;
}
function bounded(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}
