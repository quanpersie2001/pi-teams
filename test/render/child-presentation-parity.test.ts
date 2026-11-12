import { existsSync } from "node:fs";
import { type ExtensionAPI, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createAgentTranscriptPane } from "../../extension-src/pi-teams/features/agent-view/transcript-pane.js";
import { renderTranscriptItems } from "../../extension-src/pi-teams/features/agent-view/transcript-renderer.js";
import { normalizeMessage } from "../../extension-src/pi-teams/pi/child-bridge.js";
import { renderTheme } from "../helpers/render-theme.js";

const theme = renderTheme();
const tui = { requestRender() {} } as TUI;

describe("child native result presentation", () => {
	it("passes native text, images and details through the real normalizer to the native component", () => {
		const content = [
			{ type: "text", text: "output" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		];
		const details = { truncation: { truncated: true, outputLines: 3 }, diff: "+added" };
		const items = normalizeMessage({ role: "toolResult", toolCallId: "c", toolName: "read", content, details });
		const update = vi.spyOn(ToolExecutionComponent.prototype, "updateResult");
		try {
			renderTranscriptItems(items, 80, { tui, cwd: "/child", fg: theme.fg.bind(theme) }, new WeakMap());
			expect(update).toHaveBeenCalledWith({ content, details, isError: false });
		} finally {
			update.mockRestore();
		}
	});

	it("omits oversized images rather than handing the native image decoder corrupt base64", () => {
		const [item] = normalizeMessage({
			role: "toolResult",
			content: [{ type: "image", data: "A".repeat(2_000_000), mimeType: "image/png" }],
			details: { huge: "x".repeat(100_000) },
		});
		expect(item?.result).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "image" })]));
		expect(JSON.stringify(item)).toContain("truncated");
		expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThan(100_000);
	});
});

describe("actual optional pi-style display provider", () => {
	const providerFile = new URL("../../../pi-style/extension-src/pi-style/pi/tool-renderers.ts", import.meta.url);
	it.skipIf(!existsSync(providerFile)).each(["write", "tasks_get", "send_message"])(
		"switches cached child %s on live config changes and owner replacement",
		async (toolName) => {
			const { registerPublicToolRenderers } = await import(providerFile.href);
			const registerTool = vi.fn();
			const registerToolRenderer = vi.fn();
			const api = { registerTool, registerToolRenderer } as unknown as ExtensionAPI;
			const provider = registerPublicToolRenderers(api);
			const items = [
				{
					kind: "toolCall" as const,
					timestamp: 1,
					toolCallId: "same-main-id",
					toolName,
					args: { path: "/child/output.ts", content: "hello" },
				},
				...normalizeMessage({
					role: "toolResult",
					timestamp: 2,
					toolCallId: "same-main-id",
					toolName,
					content: [{ type: "text", text: "saved-child-output" }],
				}),
			];
			const pane = createAgentTranscriptPane(tui, theme, {
				cwd: "/child",
				read: () => items,
				signature: () => "fixed",
			});
			const render = () => stripTerminalSequences(pane.render(100, 40).join("\n"));
			try {
				const native = render();
				provider.configure(true);
				const styled = render();
				expect(styled).not.toBe(native);
				expect(styled).toContain("saved-child-output");
				expect(styled).toContain("output.ts");
				pane.toggleToolsExpanded();
				expect(pane.getState().toolsExpanded).toBe(true);
				provider.configure(false);
				expect(render()).not.toBe(styled);
				provider.configure(true);
				const replacement = registerPublicToolRenderers(api);
				replacement.configure(true);
				provider.clear(); // A stale owner must not remove the active port.
				expect(render()).toContain("saved-child-output");
				expect(render()).not.toBe(native);
				replacement.clear();
				expect(render()).toBe(native);
				expect(registerTool).not.toHaveBeenCalled();
				expect(registerToolRenderer).toHaveBeenCalledTimes(2);
			} finally {
				provider.clear();
				pane.dispose();
			}
		},
	);
});
