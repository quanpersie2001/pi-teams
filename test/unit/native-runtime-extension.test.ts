import { describe, expect, it, vi } from "vitest";
import { createNativeRuntimeExtension } from "../../extension-src/pi-teams/pi/native-runtime-extension.js";
import type { NativeTerminal } from "../../extension-src/pi-teams/pi/native-terminal.js";
import { FakePiHost } from "../helpers/fake-pi-host.js";

async function identityWidget(styled: boolean) {
	const host = new FakePiHost();
	const setRepaint = vi.fn();
	createNativeRuntimeExtension({
		childId: "child-1",
		name: "workflow",
		color: "#47a3e8",
		terminal: { setRepaint } as unknown as NativeTerminal,
		showIdentityWidget: () => !styled,
	})(host.extensionApi);
	await host.sessionStart();
	const factory = host.componentFactories.get("pi-teams-native-identity");
	if (!factory) throw new Error("Identity widget did not register its reconnect repaint");
	const component = factory({ requestRender() {} }, host.theme);
	return { setRepaint, lines: component.render(80) };
}

describe("native child teammate identity", () => {
	it("keeps the reconnect repaint without a duplicate widget when pi-style owns the editor frame", async () => {
		const { setRepaint, lines } = await identityWidget(true);
		expect(setRepaint).toHaveBeenCalledOnce();
		expect(lines).toEqual([]);
	});

	it("retains a visible teammate label without pi-style", async () => {
		const { lines } = await identityWidget(false);
		expect(lines.join("\n")).toContain("@workflow");
	});
});
