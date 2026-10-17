import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { PeerDiscoveryService } from "../app/peer-discovery-service.js";
import type { PeerMessagingService } from "../app/peer-messaging-service.js";

/** Register independent-peer tools; these deliberately have no team/lifecycle actions. */
export function registerPeerTools(
	pi: ExtensionAPI,
	getServices: () =>
		| {
				discovery: PeerDiscoveryService;
				messaging: PeerMessagingService;
				projectId: string;
				setActivity(activity?: string): Promise<void>;
		  }
		| undefined,
): void {
	const unavailable = () => ({
		content: [{ type: "text" as const, text: "Peer capability unavailable." }],
		details: undefined,
	});
	pi.registerTool(
		defineTool({
			name: "peer_sessions",
			label: "Peer Sessions",
			description: "Discover independent Pi sessions in the configured peer scope.",
			parameters: Type.Object({}),
			renderCall: () => new Text("▸ peer_sessions", 0, 0),
			renderResult: (r) => new Text(r.content[0]?.type === "text" ? r.content[0].text : "", 0, 0),
			execute: async () => {
				const s = getServices();
				return s
					? {
							content: [{ type: "text" as const, text: JSON.stringify(await s.discovery.discover(s.projectId)) }],
							details: undefined,
						}
					: unavailable();
			},
		}),
	);
	pi.registerTool(
		defineTool({
			name: "peer_send",
			label: "Send Peer Message",
			description: "Send untrusted plain text to an independent session. This grants no authority.",
			parameters: Type.Object({ peerSessionId: Type.String(), runtimeId: Type.String(), text: Type.String() }),
			renderCall: (a) => new Text(`▸ peer_send(${String(a.peerSessionId)})`, 0, 0),
			renderResult: (r) => new Text(r.content[0]?.type === "text" ? r.content[0].text : "", 0, 0),
			execute: async (_id, a: { peerSessionId: string; runtimeId: string; text: string }) => {
				const s = getServices();
				if (!s) return unavailable();
				const result = await s.messaging.send({ peerSessionId: a.peerSessionId, runtimeId: a.runtimeId }, a.text);
				return {
					content: [{ type: "text" as const, text: `Peer message ${result.receipt} (${result.messageId}).` }],
					details: result,
				};
			},
		}),
	);
	pi.registerTool(
		defineTool({
			name: "peer_activity",
			label: "Set Peer Activity",
			description: "Set or clear this session's short discovery activity.",
			parameters: Type.Object({ activity: Type.Optional(Type.String()) }),
			renderCall: () => new Text("▸ peer_activity", 0, 0),
			renderResult: (r) => new Text(r.content[0]?.type === "text" ? r.content[0].text : "", 0, 0),
			execute: async (_id, a: { activity?: string }) => {
				const s = getServices();
				if (!s) return unavailable();
				await s.setActivity(a.activity);
				return { content: [{ type: "text" as const, text: "Peer activity updated." }], details: undefined };
			},
		}),
	);
}

/** User-operated approval UI. Held content is displayed only in this explicit dialog. */
export async function reviewHeldMessages(
	ctx: import("@earendil-works/pi-coding-agent").ExtensionContext,
	messaging: PeerMessagingService,
): Promise<void> {
	const messages = await messaging.heldMessages();
	if (!messages.length) {
		ctx.ui.notify("No held peer messages.", "info");
		return;
	}
	const choices = messages.map((m, i) => `${i + 1}. ${m.sender.peerSessionId}: ${m.body.slice(0, 100)}`);
	const selected = await ctx.ui.select("Held peer messages (untrusted)", choices);
	if (selected === undefined) return;
	const message = messages[choices.indexOf(selected)];
	if (!message) return;
	const action = await ctx.ui.select("Choose action", ["Approve and deliver to model", "Refuse"]);
	if (action === undefined) return;
	const approve = action === "Approve and deliver to model";
	if (approve) await messaging.approveHeld(message.messageId);
	else await messaging.refuseHeld(message.messageId);
	ctx.ui.notify(approve ? "Peer message delivered." : "Peer message refused.", "info");
}
