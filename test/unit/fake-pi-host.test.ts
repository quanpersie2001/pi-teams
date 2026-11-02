import { describe, expect, it, vi } from "vitest";
import { FakePiHost } from "../helpers/fake-pi-host.js";

describe("FakePiHost subscriptions", () => {
	it("supports unsubscribe during dispatch without skipping another handler", async () => {
		const host = new FakePiHost();
		const next = vi.fn();
		const unsubscribe = host.extensionApi.on("turn_start", () => unsubscribe());
		host.extensionApi.on("turn_start", next);
		const event = { type: "turn_start" as const, turnIndex: 0, timestamp: 0 };
		await host.emit("turn_start", event);
		await host.emit("turn_start", event);
		expect(next).toHaveBeenCalledTimes(2);
		expect(host.handlers.get("turn_start")).toHaveLength(1);
	});
});
