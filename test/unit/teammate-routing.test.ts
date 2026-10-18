import { describe, expect, it } from "vitest";
import type { TeammateStatus } from "../../extension-src/pi-teams/app/agent-manager.js";
import { eligibleTeammateNames, isTeammateMessageAvailable } from "../../extension-src/pi-teams/pi/teammate-routing.js";

function status(
	name: string,
	state: TeammateStatus["state"],
	availability: TeammateStatus["availability"] = "available",
): TeammateStatus {
	return { name, type: "explore", state, availability, contextAvailable: false };
}

describe("teammate composer routing availability", () => {
	it("offers only idle/busy available roster names", () => {
		const statuses = new Map<string, TeammateStatus>([
			["idle", status("idle", "idle")],
			["busy", status("busy", "busy")],
			["released", status("released", "released")],
			["unavailable", status("unavailable", "idle", "unavailable")],
		]);
		expect(
			eligibleTeammateNames(
				["idle", "busy", "released", "unavailable", "unknown"].map((name) => ({ name })),
				(name) => statuses.get(name),
			),
		).toEqual(["idle", "busy"]);
	});

	it("hides a busy member as soon as shutdown operation is persisted", () => {
		expect(isTeammateMessageAvailable({ ...status("worker", "busy"), operation: "shutting_down" })).toBe(false);
		expect(
			eligibleTeammateNames([{ name: "worker" }], () => ({ ...status("worker", "idle"), operation: "shutting_down" })),
		).toEqual([]);
	});

	it("fails closed when a status is missing or unavailable", () => {
		expect(isTeammateMessageAvailable(undefined)).toBe(false);
		expect(isTeammateMessageAvailable(status("released", "released"))).toBe(false);
		expect(isTeammateMessageAvailable(status("worker", "busy", "unavailable"))).toBe(false);
	});
});
